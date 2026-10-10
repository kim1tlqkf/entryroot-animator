(() => {
  'use strict';
  if (window.__entryVectorSkinLoaded) return;
  window.__entryVectorSkinLoaded = true;

  const NS = 'http://www.w3.org/2000/svg';
  const identity = [1, 0, 0, 1, 0, 0];
  let session = null;
  let layersFolded = false;
  let pivotUI = null;
  let pendingSaves = [];
  let lastCross = null;
  let costumeOnionEnabled = false;
  // 기준 모양: 오브젝트 id → 고정한 모양 id. 다른 모양을 볼 때도 주황색으로 겹쳐 보인다(이 탭에서만 기억).
  const pinnedPictures = new Map();
  const pivotRecords = new WeakMap();
  const restoredLayers = new WeakMap();
  const copy = value => JSON.parse(JSON.stringify(value));
  const validPivot = value => !!value && Number.isFinite(value.dx) &&
    Number.isFinite(value.dy) && Math.abs(value.dx) < 10000 &&
    Math.abs(value.dy) < 10000;
  const validCanvasPosition = value => !!value &&
    Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Math.abs(value.x) < 10000 && Math.abs(value.y) < 10000;
  const hasNativeCanvas = object => !!object?.pictures?.some(picture =>
    picture.dimension?.entryVectorNativeCanvas);

  function rememberPivot(object, picture, pivot) {
    if (!object || !picture || !validPivot(pivot)) return;
    let records = pivotRecords.get(object);
    if (!records) { records = new Map(); pivotRecords.set(object, records); }
    records.set(picture.id, copy(pivot));
  }

  function reconcilePivots(object) {
    if (!object?.pictures) return;
    if (hasNativeCanvas(object)) return;
    const records = pivotRecords.get(object);
    object.pictures.forEach(picture => {
      if (picture.dimension?.entryVectorNativeCanvas) {
        records?.delete(picture.id);
        return;
      }
      const current = picture.dimension?.entryVectorPivot;
      if (validPivot(current)) rememberPivot(object, picture, current);
      else if (records?.has(picture.id)) {
        picture.dimension.entryVectorPivot = copy(records.get(picture.id));
        if (picture.id === object.selectedPicture?.id) {
          const pivot = picture.dimension.entryVectorPivot;
          object.entity.setRegX(object.entity.getWidth() / 2 + pivot.dx);
          object.entity.setRegY(object.entity.getHeight() / 2 + pivot.dy);
          window.Entry.stage.updateObject();
        }
      }
    });
  }

  function ensurePivotHook(entity) {
    const proto = Object.getPrototypeOf(entity);
    if (proto.__entryVectorPivotHook || typeof proto.setImage !== 'function') return;
    const original = proto.setImage;
    Object.defineProperty(proto, '__entryVectorPivotHook', { value: true });
    proto.setImage = function (picture, ...rest) {
      const result = original.call(this, picture, ...rest);
      const pivot = picture?.dimension?.entryVectorPivot;
      if (hasNativeCanvas(this.parent) || picture?.dimension?.entryVectorNativeCanvas) {
        this.setRegX(this.getWidth() / 2);
        this.setRegY(this.getHeight() / 2);
      } else if (validPivot(pivot)) {
        this.setRegX(this.getWidth() / 2 + pivot.dx);
        this.setRegY(this.getHeight() / 2 + pivot.dy);
      }
      return result;
    };
  }

  function multiply(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  function inverse(m) {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) throw Error('모양의 변환을 계산할 수 없습니다.');
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d,
      (m[2] * m[5] - m[3] * m[4]) / d,
      (m[1] * m[4] - m[0] * m[5]) / d];
  }
  const at = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5] });
  function rotate(x, y, degrees) {
    const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
  }
  const degrees = (x, y) => Math.atan2(y, x) * 180 / Math.PI;
  const clean = x => Math.round(x * 1000) / 1000;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function paintLayer(ep) {
    const layers = ep.project.getItems({ class: ep.paper.Layer }).filter(layer =>
      layer.parent?.className === 'Layer' &&
      layer.parent.children.some(sibling => sibling.className === 'Shape'));
    if (layers.length !== 1) return null;
    const stage = layers[0].parent.children.find(item =>
      item.className === 'Shape')?.bounds;
    return { layer: layers[0], stage };
  }
  function context() {
    const E = window.Entry, p = E?.playground?.painter, ep = p?.entryPaint;
    const object = E?.container?.selectedObject;
    const root = document.getElementById('entryPainter');
    if (!root || !root.getClientRects().length || !object?.selectedPicture ||
        E.playground.object !== object || !ep?.project ||
        !['VECTOR', 'BITMAP'].includes(ep.mode)) return null;
    const found = paintLayer(ep);
    if (!found) return null;
    const canvas = root.querySelector('.canvas_area #paint_canvas');
    if (!canvas) return null;
    return { E, p, ep, object, picture: object.selectedPicture, root,
      canvas, ...found };
  }
  // 저장 대상은 편집기 파일로 찾는다. 수정 중 다른 모양을 누르면 엔트리는 선택 모양을 먼저 바꾼 뒤
  // 확인창에서 이전 모양을 저장하므로, 그때 selectedPicture는 저장할 모양이 아니다.
  function saveContext(painter) {
    const E = window.Entry, ep = painter?.entryPaint, file = painter?.file;
    if (!ep?.project || !file || !['VECTOR', 'BITMAP'].includes(ep.mode)) return null;
    const object = E?.container?.getObject?.(file.objectId) || E?.container?.selectedObject;
    const picture = object?.pictures?.find(item => item.id === file.id);
    const found = picture && paintLayer(ep);
    return found ? { E, p: painter, ep, object, picture, ...found } : null;
  }
  // 십자는 같은 편집기 안에서 모양을 바꿔도 같은 자리다. 모양 탭을 나가며 저장하면 십자 UI가
  // 먼저 지워질 수 있어 마지막 위치를 따로 둔다.
  const crossPoint = c => pivotUI?.ep === c.ep ? pivotUI.point :
    lastCross?.ep === c.ep ? lastCross.point :
      { ...(homeCenter(c.ep) || c.ep.paper.view.center) };

  const canvasBox = c => c?.layer?.children?.find(item =>
    item.data?.entryVectorCanvasBox === '1');
  const artItems = c => [...c.layer.children].filter(item =>
    item.className !== 'Raster' && item.data?.entryVectorCanvasBox !== '1');
  // 빈 Path(점 하나 없는 경로)는 bounds가 원점 (0,0,0,0)이라 합치면 범위가 원점까지 늘어난다.
  // paper.js의 layer.bounds처럼 크기 0인 항목은 범위 계산에서 뺀다.
  const hasArea = box => box.width > 0 || box.height > 0;
  const artBounds = c => artItems(c).reduce((bounds, item) => !hasArea(item.bounds) ? bounds :
    bounds ? bounds.unite(item.bounds) : item.bounds.clone(), null);
  // 비트맵 탭: 엔트리는 그림을 무대 크기 Raster로 합치고, PNG 저장(getDataURL)은 무대 밖을
  // 잘라낸 뒤 alpha > 0 범위로 트림한다. 그래서 비트맵의 그림 범위는 Raster bounds가 아니라
  // 실제 픽셀 범위로 잡고, 기준점 상자는 무대 안에 둔다. 벡터 탭은 이 분기를 타지 않는다.
  const bitmapMode = c => c.ep.mode === 'BITMAP';
  // 기준점은 불투명도 1%(알파 약 3)라 그림 범위를 잴 때는 이보다 옅은 픽셀을 뺀다.
  const FAINT_ALPHA = 3;
  let inkGeneration = 0;
  const inkCache = new WeakMap();
  function rasterInk(item) {
    const cached = inkCache.get(item);
    if (cached?.generation === inkGeneration) return cached.ink;
    let ink;
    try {
      const width = item.width, height = item.height;
      const pixels = item.getImageData().data;
      let left = width, top = height, right = -1, bottom = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
          if (pixels[row + x * 4 + 3] <= FAINT_ALPHA) continue;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          bottom = y;
        }
      }
      ink = right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
    } catch { ink = undefined; }
    inkCache.set(item, { generation: inkGeneration, ink });
    return ink;
  }
  function itemBounds(c, item) {
    const ink = bitmapMode(c) && item.className === 'Raster' ? rasterInk(item) : null;
    if (!ink) return item.bounds;
    const corners = [[ink.left, ink.top], [ink.right, ink.top],
      [ink.left, ink.bottom], [ink.right, ink.bottom]].map(([x, y]) =>
      item.matrix.transform(new c.ep.paper.Point(x - item.width / 2,
        y - item.height / 2)));
    const xs = corners.map(point => point.x), ys = corners.map(point => point.y);
    const left = Math.min(...xs), top = Math.min(...ys);
    return new c.ep.paper.Rectangle(left, top,
      Math.max(...xs) - left, Math.max(...ys) - top);
  }
  // 비트맵 캔버스는 무대 크기라 상자도 무대 안에 둔다. 벡터 상자는 그림을 다 감싸도록 제한하지 않고,
  // 엔트리가 무대 밖을 잘라 만드는 PNG 대신 저장 때 그림 전체 PNG를 넣는다(ensureSaveHook).
  function stageHalf(c, center) {
    if (!bitmapMode(c) || !c.stage) return { x: Infinity, y: Infinity };
    return { x: Math.floor(Math.min(center.x - c.stage.left, c.stage.right - center.x)),
      y: Math.floor(Math.min(center.y - c.stage.top, c.stage.bottom - center.y)) };
  }
  // 그림 전체 이동 대상: PNG 이미지(Raster)도 포함. 리깅 조각 목록(artItems)은 그대로 둔다.
  const movableItems = c => [...c.layer.children].filter(item =>
    item.data?.entryVectorCanvasBox !== '1' &&
    !(bitmapMode(c) && item.className === 'Raster' && rasterInk(item) === null));
  const movableBounds = c => movableItems(c).reduce((bounds, item) => {
    const box = itemBounds(c, item);
    if (!hasArea(box)) return bounds;
    return bounds ? bounds.unite(box) : box.clone();
  }, null);

  // 공통 상자: 한 오브젝트에서 확장으로 저장한 모양은 모두 같은 크기를 쓴다. 크기는 모양마다
  // 기록한 그림 퍼짐(십자에서 그림 끝까지, 여백 제외)의 최댓값에 여백을 더해 정하므로, 가장 큰
  // 그림이 작아지면 상자도 같이 줄어든다. 기록이 없는 예전 모양은 지금 크기를 그대로 쓴다.
  const MARGIN = 24;
  const validArt = art => !!art && [art.x, art.y].every(value =>
    Number.isFinite(value) && value >= 0 && value < 20000);
  const artHalfOf = (bounds, center) => bounds && {
    x: clean(Math.max(Math.abs(bounds.left - center.x), Math.abs(bounds.right - center.x))),
    y: clean(Math.max(Math.abs(bounds.top - center.y), Math.abs(bounds.bottom - center.y))) };
  // 픽셀 아트(오브젝트별): 엔트리 실행 화면에는 보간을 끄는 설정이 없다(entry.min.js 260921: 작품·오브젝트
  // 데이터로 보간을 바꾸는 분기 없음). 대신 SVG 안의 PNG에 image-rendering:pixelated를 주고 fileurl로 걸면
  // 크롬이 각지게 그린다. 오브젝트의 같은 크기 모양들을 SVG 한 장(아틀라스)에 칸으로 모아 한 번만 올리고
  // 모양마다 fileurl을 "아틀라스.svg#f번호"로 걸어 자기 칸만 보이게 한다(dimension.entryVectorPixel = 1,
  // entryVectorAtlas). 모양 PNG(파일 이름)는 그대로라 fileurl이 빠지면 보통 그림으로 보인다.
  // 예전 방식(PNG를 k배로 키우고 오브젝트 크기 1/k, entryVectorPixel = k > 1)으로 만든 오브젝트도 그대로 쓴다.
  // 편집기에서는 원래 해상도로 열어 실제 픽셀을 다룬다. 그림 퍼짐 기록과 공통 크기는 그림 단위(원래 픽셀)로 둔다.
  const PIXEL_MARGIN = 1;
  const pixelOf = picture => {
    const k = Number(picture?.dimension?.entryVectorPixel);
    return Number.isInteger(k) && k >= 1 && k <= 64 ? k : 0;
  };
  const objectPixel = object =>
    (object?.pictures || []).reduce((k, picture) => k || pixelOf(picture), 0);
  const marginOf = picture => pixelOf(picture) ? PIXEL_MARGIN : MARGIN;
  // 편집기 1px이 그림 단위로 몇인가. 픽셀 모양을 원래 해상도로 열지 못했으면 키운 그대로다.
  const editorScale = c => {
    const k = pixelOf(c.picture);
    return k > 1 && c.p?.__evrUnbaked !== c.picture.id ? k : 1;
  };
  function needHalf(picture) {
    const dimension = picture.dimension || {}, margin = marginOf(picture);
    if (validArt(dimension.entryVectorArt)) return {
      x: Math.ceil(dimension.entryVectorArt.x + margin),
      y: Math.ceil(dimension.entryVectorArt.y + margin) };
    const k = pixelOf(picture) || 1;
    const width = Number(dimension.width), height = Number(dimension.height);
    return { x: width > 0 && width < 20000 ? Math.ceil(width / k / 2) : 0,
      y: height > 0 && height < 20000 ? Math.ceil(height / k / 2) : 0 };
  }
  function commonHalf(object, skipId) {
    return (object?.pictures || []).reduce((half, picture) => {
      if (picture.id === skipId || !picture.dimension?.entryVectorNativeCanvas) return half;
      const need = needHalf(picture);
      return { x: Math.max(half.x, need.x), y: Math.max(half.y, need.y) };
    }, { x: 0, y: 0 });
  }
  // 지금 편집 중인 모양을 뺀 나머지의 공통 크기. 새 모양으로 저장하면 원래 모양도 남으므로 넣는다.
  const sharedHalf = c => commonHalf(c.object,
    c.p?.file?.mode === 'new' ? null : c.picture.id);

  function ensureCanvasBox(c) {
    const existing = canvasBox(c);
    const unit = editorScale(c), common = sharedHalf(c);
    const shared = { x: common.x * unit, y: common.y * unit };
    if (existing) {
      existing.locked = true;
      const bounds = movableBounds(c);
      if (bounds) {
        const center = crossPoint(c);
        const old = existing.bounds;
        const limit = stageHalf(c, center);
        const halfWidth = Math.min(limit.x, Math.ceil(Math.max(old.width / 2, shared.x,
          Math.abs(bounds.left - center.x) + 8,
          Math.abs(bounds.right - center.x) + 8)));
        const halfHeight = Math.min(limit.y, Math.ceil(Math.max(old.height / 2, shared.y,
          Math.abs(bounds.top - center.y) + 8,
          Math.abs(bounds.bottom - center.y) + 8)));
        if (halfWidth * 2 > old.width + 0.1 ||
            halfHeight * 2 > old.height + 0.1 ||
            old.width > limit.x * 2 + 0.1 || old.height > limit.y * 2 + 0.1) {
          existing.bounds = new c.ep.paper.Rectangle(center.x - halfWidth,
            center.y - halfHeight, halfWidth * 2, halfHeight * 2);
          c.p.file.modified = true;
        }
      }
      return existing;
    }
    const center = crossPoint(c);
    const art = artHalfOf(movableBounds(c), center);
    if (!art) return null;
    const limit = stageHalf(c, center), margin = marginOf(c.picture) * unit;
    const halfWidth = Math.min(limit.x, Math.max(shared.x, Math.ceil(art.x + margin)));
    const halfHeight = Math.min(limit.y, Math.max(shared.y, Math.ceil(art.y + margin)));
    const box = new c.ep.paper.Group({ insert: false });
    const left = center.x - halfWidth, top = center.y - halfHeight;
    const size = 2;
    for (const [x, y] of [[left, top], [left + halfWidth * 2 - size, top],
      [left, top + halfHeight * 2 - size],
      [left + halfWidth * 2 - size, top + halfHeight * 2 - size]]) {
      box.addChild(new c.ep.paper.Path.Rectangle({
        rectangle: new c.ep.paper.Rectangle(x, y, size, size),
        fillColor: new c.ep.paper.Color(0, 0, 0, 0.01),
        strokeColor: null, insert: false,
      }));
    }
    box.data.entryVectorCanvasBox = '1';
    c.layer.insertChild(0, box);
    box.locked = true;
    c.p.file.modified = true;
    return box;
  }

  function pngSize(png) {
    if (!png?.startsWith('data:image/png;base64,')) return null;
    const header = atob(png.slice(22, 66));
    const number = offset => ((header.charCodeAt(offset) << 24) >>> 0) +
      (header.charCodeAt(offset + 1) << 16) +
      (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3);
    const size = { width: number(16), height: number(20) };
    return size.width > 0 && size.height > 0 ? size : null;
  }
  // 엔트리가 실제로 저장한 그림 크기. 벡터는 내보낸 SVG의 viewBox, 비트맵은 PNG 머리말을 읽는다.
  function savedSize(c, svgText) {
    let values;
    if (bitmapMode(c)) {
      const size = pngSize(c.ep.getDataURL());
      if (size) values = [0, 0, size.width, size.height];
    } else {
      const root = new DOMParser().parseFromString(svgText || c.ep.exportSVG(),
        'image/svg+xml').documentElement;
      values = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    }
    return values?.length === 4 && values.every(Number.isFinite) &&
      values[2] > 0 && values[3] > 0 ? { width: values[2], height: values[3] } : null;
  }
  const pictureKey = picture => JSON.stringify([picture.fileurl, picture.filename,
    picture.dimension?.width, picture.dimension?.height]);
  // 상단 저장하기, 새 모양으로 저장하기, 모양을 바꾸거나 모양 탭을 나갈 때의 확인창 저장은 모두
  // painter.fileSave를 거친다. 그래서 버튼 클릭이 아니라 fileSave에서 기준점 상자를 맞춘다.
  function prepareSave(painter) {
    if (!window.Entry?.stage?.selectedObject) return null; // 엔트리도 이때는 저장하지 않는다.
    inkGeneration++;
    const c = saveContext(painter);
    const art = c && (artItems(c)[0] || movableItems(c)[0]);
    if (!art) return null;
    // 엔트리는 SVG를 열 때 기준점 상자까지 전부 선택하므로, 선택 도구로 옮기거나 크기를 바꾸면
    // 상자도 따라간다. 저장 직전에 기존 상자를 버리고 지금 그림 범위로 십자 대칭 상자를 다시 만든다.
    canvasBox(c)?.remove();
    // 비트맵은 예전 기준점이 그림 픽셀에 박혀 있어, 상자가 줄면 그 점이 새 상자 밖에 남아 저장
    // 크기가 틀어진다. 저장 전에 기준점만큼 옅은 픽셀을 지운다.
    if (bitmapMode(c)) clearFaintPixels(c);
    const unit = editorScale(c), pixel = pixelOf(c.picture);
    const seen = artHalfOf(movableBounds(c), crossPoint(c));
    if (!seen || !ensureCanvasBox(c)) return null;
    const drawn = { x: clean(seen.x / unit), y: clean(seen.y / unit) };
    delete art.data.entryVectorCanvasPosition;
    delete art.data.entryVectorPivotOffset;
    const others = sharedHalf(c), margin = marginOf(c.picture);
    return { c, mode: painter.file.mode, art: drawn, pixel,
      // 원래 해상도로 연 픽셀 모양은 저장할 때 k배로 키운다.
      bake: bitmapMode(c) && pixel && unit === 1 ? pixel : 0,
      // 이 저장 뒤 오브젝트 전체가 쓸 공통 크기(절반, 그림 단위). 다른 모양을 이 크기로 맞춘다.
      common: { x: Math.max(others.x, Math.ceil(drawn.x + margin)),
        y: Math.max(others.y, Math.ceil(drawn.y + margin)) },
      before: new Map(c.object.pictures.map(picture => [picture.id, pictureKey(picture)])) };
  }
  // 엔트리 비트맵 저장(getDataURL)처럼 무대 밖을 자르고 투명하지 않은 범위로 줄인 원래 해상도 그림.
  function savedBitmapArt(c) {
    const raster = c.layer.rasterize({ resolution: 72, insert: false });
    const bounds = raster.bounds, stage = c.stage || bounds;
    const left = Math.max(0, Math.round(stage.left - bounds.left));
    const top = Math.max(0, Math.round(stage.top - bounds.top));
    const right = Math.min(raster.width, Math.round(stage.right - bounds.left));
    const bottom = Math.min(raster.height, Math.round(stage.bottom - bounds.top));
    if (right <= left || bottom <= top) return null;
    const data = raster.getImageData(new c.ep.paper.Rectangle(left, top, right - left, bottom - top));
    const { width, height } = data, pixels = data.data;
    let l = width, t = height, r = -1, b = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!pixels[(y * width + x) * 4 + 3]) continue;
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        b = y;
      }
    }
    if (r < 0) return null;
    const crop = canvasOfSize(r - l + 1, b - t + 1);
    crop.getContext('2d').putImageData(data, -l, -t);
    return crop;
  }
  const canvasOfSize = (width, height) => Object.assign(document.createElement('canvas'),
    { width, height });
  // 가장 가까운 픽셀로만 크기를 바꾼다(보간 없음).
  function scaledCanvas(source, width, height) {
    const canvas = canvasOfSize(width, height), context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }
  function clearFaintPixels(c) {
    for (const item of c.layer.children) {
      if (item.className !== 'Raster') continue;
      try {
        const data = item.getImageData();
        const pixels = data.data;
        let changed = false;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] && pixels[i] <= FAINT_ALPHA) { pixels[i] = 0; changed = true; }
        }
        if (changed) item.setImageData(data, new c.ep.paper.Point(0, 0));
      } catch { /* 읽을 수 없는 이미지는 그대로 둔다 */ }
    }
    inkGeneration++;
  }
  function ensureSaveHook(painter) {
    const proto = Object.getPrototypeOf(painter);
    if (proto.__entryVectorSaveHook || typeof proto.fileSave !== 'function') return;
    const original = proto.fileSave;
    Object.defineProperty(proto, '__entryVectorSaveHook', { value: true });
    proto.fileSave = function (...args) {
      // 모양 그림이 아직 들어오지 않았으면 편집기에는 이전 모양 그림이 남아 있어, 저장하면 그 그림이 이
      // 모양에 들어간다(ensureLoadHook). 저장하지 않고 알린다.
      if (this.__evrLoading) {
        toast('모양 그림을 불러오는 중이라 저장하지 않았습니다. 그림이 보인 뒤 다시 저장하세요.', 5000);
        return undefined;
      }
      // 확장 쪽 준비가 실패해도 엔트리 원래 저장은 그대로 실행한다.
      let prepared = null;
      try { prepared = prepareSave(this); }
      catch (error) { console.warn('[entry-vector-rig] 저장 준비 실패', error); }
      // 실행 화면은 SVG가 아니라 함께 올린 PNG를 모양 크기에 맞춰 그린다. 엔트리 PNG는 무대 밖을
      // 잘라내 모서리 점이 사라지므로, 벡터는 저장하는 동안만 그림 전체 범위 PNG로 바꿔 넣는다.
      const ep = this.entryPaint;
      let fullPng = null, pixelSvg = null;
      if (prepared && (!bitmapMode(prepared.c) || prepared.bake)) {
        try {
          if (prepared.bake) {
            // 픽셀 모양: k배 PNG와 SVG(pixelated)를 함께 만든다.
            const art = savedBitmapArt(prepared.c);
            if (art) ({ image: fullPng, svg: pixelSvg } = pixelPayload(art, prepared.bake));
          } else {
            const png = prepared.c.layer.rasterize({ resolution: 72, insert: false }).toDataURL();
            if (pngSize(png)) fullPng = png;
          }
        } catch (error) { console.warn('[entry-vector-rig] 전체 PNG 만들기 실패', error); }
      }
      const ownGetter = !!ep && Object.prototype.hasOwnProperty.call(ep, 'getDataURL');
      const previousGetter = ep?.getDataURL;
      if (fullPng) ep.getDataURL = () => fullPng;
      // 픽셀 모양은 엔트리 저장 요청에 SVG를 붙여 올린다. fileurl은 저장이 끝난 뒤 settleSave에서 건다.
      const E = window.Entry, previousDispatch = E.dispatchEvent;
      const ownDispatch = Object.prototype.hasOwnProperty.call(E, 'dispatchEvent');
      if (pixelSvg) E.dispatchEvent = function (name, payload, ...rest) {
        if (name === 'saveCanvasImage' && payload?.file) {
          payload.file.ext = 'svg';
          payload.file.svg = pixelSvg;
        }
        return previousDispatch.call(this, name, payload, ...rest);
      };
      let result;
      try { result = original.apply(this, args); }
      finally {
        if (fullPng) {
          if (ownGetter) ep.getDataURL = previousGetter;
          else delete ep.getDataURL;
        }
        if (pixelSvg) {
          if (ownDispatch) E.dispatchEvent = previousDispatch;
          else delete E.dispatchEvent;
        }
      }
      try {
        const size = prepared && (pngSize(fullPng) || savedSize(prepared.c, this.file?.svg));
        if (size) pendingSaves.push({ object: prepared.c.object,
          pictureId: prepared.c.picture.id, mode: prepared.mode,
          before: prepared.before, size, art: prepared.art, pixel: prepared.pixel,
          pixelSvg: !!pixelSvg, at: Date.now() });
      } catch (error) { console.warn('[entry-vector-rig] 저장 크기 확인 실패', error); }
      // 엔트리 저장과 동시에 다른 모양도 공통 크기로 맞춘다.
      try {
        if (prepared) startUnify(prepared.c.object, prepared.common,
          prepared.mode === 'new' ? null : prepared.c.picture.id);
      } catch (error) { console.warn('[entry-vector-rig] 공통 상자 맞추기 실패', error); }
      return result;
    };
  }
  // 엔트리는 업로드가 끝난 뒤 모양 주소와 크기를 바꾼다. 확인창 저장이면 그때 편집기는 이미 다음
  // 모양을 열고 있으므로, 저장 순간에 잰 크기를 모양 id로 찾아 넣는다.
  function settleSave(record) {
    const { object } = record;
    const picture = record.mode === 'new' ?
      object.pictures.find(item => !record.before.has(item.id)) :
      object.pictures.find(item => item.id === record.pictureId &&
        pictureKey(item) !== record.before.get(item.id));
    if (!picture?.dimension) return false;
    picture.dimension.width = record.size.width;
    picture.dimension.height = record.size.height;
    picture.dimension.entryVectorNativeCanvas = true;
    if (validArt(record.art)) picture.dimension.entryVectorArt = copy(record.art);
    if (record.pixel) picture.dimension.entryVectorPixel = record.pixel;
    // 픽셀 모양: 실행 화면이 SVG(pixelated)를 쓰게 한다. imageType을 svg로 둬야 .ent에도 SVG가
    // 묶인다(편집은 확장이 비트맵으로 연다).
    if (record.pixelSvg && picture.filename) {
      picture.fileurl = svgFile(picture.filename);
      picture.imageType = 'svg';
    }
    delete picture.dimension.entryVectorPivot;
    delete picture.dimension.entryVectorAtlas; // 다시 저장한 모양은 아틀라스 칸이 아니다
    pivotRecords.get(object)?.delete(picture.id);
    if (object.entity?.picture?.id === picture.id) {
      object.entity.setImage(picture);
      object.entity.setRegX(object.entity.getWidth() / 2);
      object.entity.setRegY(object.entity.getHeight() / 2);
      window.Entry.stage.updateObject();
    }
    return true;
  }

  // 다른 모양을 공통 크기로 맞춘다. 엔트리 저장 처리는 저장 중에 들어온 저장을 버려 한 번에 하나씩만
  // 되므로, 엔트리와 같은 업로드 요청(/rest/picture/canvas)을 직접 동시에 보내고 결과를 엔트리처럼
  // 모양 목록에 반영한다. 그림은 그대로 두고 가운데 기준으로 여백만 넓히거나 줄인다.
  const unifyGeneration = new WeakMap();
  const measuredKeys = new Set();
  const pictureFile = picture => picture.filename || picture.fileurl;
  const runtimePng = name => `${window.Entry.defaultPath || ''}/uploads/` +
    `${name.substring(0, 2)}/${name.substring(2, 4)}/image/${name}.png`;
  const svgFile = name => runtimePng(name).replace(/\.png$/, '.svg');
  const cornersOf = size => [[0, 0], [size.width - 2, 0], [0, size.height - 2],
    [size.width - 2, size.height - 2]];
  // cors가 참이면 엔트리 편집기(paper Raster, crossOrigin anonymous)와 같은 방식으로 받아 캐시를 같이 쓴다.
  function loadImage(src, cors) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (cors) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(Error(`이미지를 읽을 수 없습니다: ${src}`));
      image.src = src;
    });
  }
  const isBoxNode = node => {
    try { return JSON.parse(node.getAttribute('data-paper-data') || '{}')
      .entryVectorCanvasBox === '1'; } catch { return false; }
  };
  async function readSvg(picture) {
    const response = await fetch(window.Entry.playground.painter.getImageSrc(picture));
    if (!response.ok) throw Error(`SVG를 읽을 수 없습니다 (${response.status})`);
    const root = new DOMParser().parseFromString(await response.text(), 'image/svg+xml')
      .documentElement;
    const view = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    if (root.nodeName !== 'svg' || view?.length !== 4 || !view.every(Number.isFinite) ||
        !(view[2] > 0 && view[3] > 0)) throw Error('viewBox가 없는 SVG입니다.');
    const box = [...root.children].find(isBoxNode);
    if (!box) throw Error('기준점 상자가 없는 SVG입니다.');
    return { root, view, box };
  }
  // SVG를 이미지로 그려 캔버스로 만든다. 문서에 넣지 않으므로 SVG 안의 스크립트는 실행되지 않는다.
  async function renderSvg(root, width, height) {
    const copy = root.cloneNode(true);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],
      { type: 'image/svg+xml' }));
    try {
      const image = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width); canvas.height = Math.ceil(height);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { URL.revokeObjectURL(url); }
  }
  async function pictureCanvas(picture) {
    if (picture.imageType === 'svg') {
      const { root, view } = await readSvg(picture);
      return renderSvg(root, view[2], view[3]);
    }
    const image = await loadImage(window.Entry.playground.painter.getImageSrc(picture));
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  }
  // 예전에 저장해 그림 퍼짐 기록이 없는 모양은 그림 픽셀로 한 번 재서 기록한다(업로드 없음).
  const measureArt = async picture => artOfCanvas(await pictureCanvas(picture));
  // 캔버스 가운데에서 그림(기준점보다 진한 픽셀) 끝까지의 거리.
  function artOfCanvas(canvas) {
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (pixels[row + x * 4 + 3] <= FAINT_ALPHA) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
    return right < 0 ? null : artHalfOf({ left, top, right: right + 1, bottom: bottom + 1 },
      { x: width / 2, y: height / 2 });
  }
  function measureMissingArt(object) {
    for (const picture of object?.pictures || []) {
      if (!picture.dimension?.entryVectorNativeCanvas || validArt(picture.dimension.entryVectorArt) ||
          (picture.imageType !== 'svg' && picture.imageType !== 'png')) continue;
      const file = pictureFile(picture), key = `${picture.id}:${file}`;
      if (!file || measuredKeys.has(key)) continue;
      measuredKeys.add(key);
      // 픽셀 모양은 원래 해상도 그림에서 바로 잰다(그림 단위).
      (pixelOf(picture) ? pixelArtOf(picture).then(artOfCanvas) : measureArt(picture)).then(art => {
        const current = object.pictures.find(item => item.id === picture.id);
        if (art && current?.dimension && pictureFile(current) === file &&
            !validArt(current.dimension.entryVectorArt)) current.dimension.entryVectorArt = art;
      }).catch(error => console.warn('[entry-vector-rig] 그림 범위 재기 실패', picture.name, error));
    }
  }
  async function resizedSvg(picture, size) {
    const { root, view: [x0, y0, width, height], box } = await readSvg(picture);
    const left = x0 + (width - size.width) / 2, top = y0 + (height - size.height) / 2;
    box.removeAttribute('transform');
    box.replaceChildren(...cornersOf(size).map(([x, y]) => {
      const dot = root.ownerDocument.createElementNS(NS, 'path');
      dot.setAttribute('d', `M${left + x},${top + y}h2v2h-2z`);
      return dot;
    }));
    root.setAttribute('viewBox', `${left} ${top} ${size.width} ${size.height}`);
    const svg = new XMLSerializer().serializeToString(root);
    const canvas = await renderSvg(root, size.width, size.height);
    return { ext: 'svg', svg, image: canvas.toDataURL('image/png'), size };
  }
  async function resizedPng(picture, size) {
    const image = await loadImage(window.Entry.playground.painter.getImageSrc(picture));
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, Math.floor((size.width - image.naturalWidth) / 2),
      Math.floor((size.height - image.naturalHeight) / 2));
    context.fillStyle = 'rgba(0, 0, 0, 0.01)';
    for (const [x, y] of cornersOf(size)) context.fillRect(x, y, 2, 2);
    return { ext: 'png', image: canvas.toDataURL('image/png'), size };
  }
  // 픽셀 모양은 원래 해상도에서 여백을 맞춘 뒤 SVG 방식으로 다시 만든다(size는 k배 크기).
  async function resizedPixel(picture, size, k) {
    const art = await pixelArtOf(picture);
    const target = { width: Math.round(size.width / k), height: Math.round(size.height / k) };
    const canvas = canvasOfSize(target.width, target.height), context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(art, Math.floor((target.width - art.width) / 2),
      Math.floor((target.height - art.height) / 2));
    context.fillStyle = 'rgba(0, 0, 0, 0.01)';
    for (const [x, y] of cornersOf(target)) context.fillRect(x, y, 2, 2);
    return pixelPayload(canvas, k);
  }
  // 이전 버전은 상자가 무대보다 크면 잘린 PNG를 올렸다. 실행 화면은 PNG를 쓰므로 크기가 다르면 고친다.
  async function runtimePngMatches(picture) {
    if (picture.imageType !== 'svg' || picture.fileurl || !picture.filename) return true;
    try {
      const image = await loadImage(runtimePng(picture.filename));
      return Math.abs(image.naturalWidth - picture.dimension.width) <= 0.5 &&
        Math.abs(image.naturalHeight - picture.dimension.height) <= 0.5;
    } catch { return true; }
  }
  // 엔트리 저장 처리와 같은 업로드 요청. 응답은 엔트리 모양 데이터(파일 이름 등)다.
  // 실제로 본 실패 두 가지: 6개씩 몰아 보내자 연결이 끊겼고(ERR_CONNECTION_RESET), 하나씩 보내도
  // 가끔 응답이 영영 안 오는 요청이 있었다(정상 0.1~1초, 멈춘 요청은 20초 넘게 무응답).
  // (시험에서 14개 중 2개가 9개 간격으로 멈춤.) 동시 3개로 보내자 사용자 크롬에서는 업로드와 그림
  // 불러오기가 함께 끊겼다(같은 서버 연결이 통째로 끊긴 모습). 그래서 요청마다 시간 제한을 두고 넘기면
  // 바로 다시 보내고, 연결이 끊기면 모든 업로드를 잠깐 멈췄다가 한동안 1개씩만 보낸다.
  const UPLOAD_SLOTS = 2;
  let uploadPauseUntil = 0;
  // 정상 응답은 1초 안쪽이었다. 큰 그림은 보내는 데 오래 걸릴 수 있어 크기만큼 더 기다린다.
  const uploadTimeout = payload => 4000 +
    Math.ceil(((payload.image?.length || 0) + (payload.svg?.length || 0)) / 200000) * 1000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let uploadSlots = UPLOAD_SLOTS, slotsRestore = 0, uploadsActive = 0;
  const uploadWaiters = [];
  async function withUploadSlot(task) {
    while (uploadsActive >= uploadSlots) await new Promise(resolve => uploadWaiters.push(resolve));
    uploadsActive++;
    try {
      while (Date.now() < uploadPauseUntil) await sleep(uploadPauseUntil - Date.now());
      return await task();
    } finally { uploadsActive--; uploadWaiters.shift()?.(); }
  }
  // 연결이 끊기면 모든 업로드를 잠깐 멈추고, 한동안(마지막 끊김부터 SLOW_MS) 1개씩만 보낸다.
  // 처음엔 1분이었는데, 끊김 한 번에 1분 내내 속도가 절반이 돼 15초로 줄였다. 또 끊기면 다시 센다.
  const SLOW_MS = 15000;
  function slowDownUploads(pause) {
    uploadPauseUntil = Math.max(uploadPauseUntil, Date.now() + pause);
    uploadSlots = 1;
    clearTimeout(slotsRestore);
    slotsRestore = setTimeout(() => {
      uploadSlots = UPLOAD_SLOTS;
      uploadWaiters.splice(0).forEach(resolve => resolve());
    }, SLOW_MS);
  }
  async function uploadOnce(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), uploadTimeout(payload));
    try {
      let response;
      try {
        response = await fetch('/rest/picture/canvas', { method: 'POST', credentials: 'same-origin',
          signal: controller.signal,
          headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: payload.image, svg: payload.svg, ext: payload.ext, notrim: true }) });
      } catch (error) {
        throw Object.assign(Error(controller.signal.aborted ? '모양 업로드 응답이 없습니다' :
          `모양 업로드 연결이 끊겼습니다 (${error.message})`),
        { retry: true, timeout: controller.signal.aborted });
      }
      if (!response.ok) throw Object.assign(Error(`모양 업로드 실패 (${response.status})`),
        { retry: response.status === 429 || response.status >= 500, status: response.status });
      const saved = await response.json();
      if (typeof saved?.filename !== 'string') throw Error('업로드 응답에 파일 이름이 없습니다.');
      return saved;
    } finally { clearTimeout(timer); }
  }
  async function withRetries(once) {
    for (let attempt = 0; ; attempt++) {
      try { return await withUploadSlot(once); }
      catch (error) {
        if (!error.retry || attempt >= 7) throw error;
        if (error.timeout) continue; // 응답 없는 요청은 기다리지 않고 바로 다시 보낸다.
        slowDownUploads(Math.min(8000, 1000 * 2 ** attempt));
      }
    }
  }
  async function uploadPayload(payload) {
    return withRetries(() => uploadOnce(payload));
  }
  // 엔트리 "파일 올리기"가 쓰는 여러 장 업로드. 폼에 type=user, uploadFile0, uploadFile1…을 담는다.
  // 시험(2026-10-07, 로그인 안 한 빈 작품): 서버는 한 요청에 10장까지만 처리하고 나머지는 말없이
  // 버렸다(20장 → 10장 응답). 같은 PNG 조각 10장을 번갈아 재니 묶음 1.4초, 낱장(동시 2개) 6.6초.
  // 5배 PNG 10장도 0.36초(같은 때 일반 PNG 0.67초)로 빨랐다. SVG도 받지만 서버가 PNG로 바꾸느라
  // 10장 20초(낱장 7초)라 SVG는 묶음으로 보내지 않는다(uploadArts 설명).
  // 응답 항목은 보낸 파일 이름(name)으로 맞춘다.
  const BATCH_FILES = 10;
  async function uploadBatchOnce(files) {
    const controller = new AbortController();
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const timer = setTimeout(() => controller.abort(), 6000 + Math.ceil(bytes / 200000) * 1000);
    try {
      const form = new FormData();
      form.append('type', 'user');
      files.forEach((file, index) => form.append(`uploadFile${index}`, file));
      let response;
      try {
        response = await fetch('/rest/picture/upload', { method: 'POST', credentials: 'same-origin',
          signal: controller.signal, body: form });
      } catch (error) {
        throw Object.assign(Error(controller.signal.aborted ? '모양 업로드 응답이 없습니다' :
          `모양 업로드 연결이 끊겼습니다 (${error.message})`),
        { retry: true, timeout: controller.signal.aborted });
      }
      if (!response.ok) throw Object.assign(Error(`모양 묶음 업로드 실패 (${response.status})`),
        { retry: response.status === 429 || response.status >= 500,
          unsupported: [400, 404, 405, 413, 415].includes(response.status) });
      const json = await response.json().catch(() => null);
      if (!Array.isArray(json?.uploads))
        throw Object.assign(Error('묶음 업로드 응답 형식이 다릅니다.'), { unsupported: true });
      return new Map(json.uploads.filter(item => typeof item?.filename === 'string')
        .map(item => [item.name, item]));
    } finally { clearTimeout(timer); }
  }
  async function uploadBatch(files) {
    return withRetries(() => uploadBatchOnce(files));
  }
  async function uploadPicture(object, picture, payload, isCurrent, patch) {
    applyUploaded(object, picture, await uploadPayload(payload), payload, patch, isCurrent);
  }
  // patch의 값이 undefined인 키는 모양 크기 정보에서 지운다.
  function applyUploaded(object, picture, saved, payload, patch = {}, isCurrent = () => true) {
    // 그 사이 사용자가 그 모양을 다시 저장했거나 지웠거나 더 새 맞추기가 시작됐으면 덮어쓰지 않는다.
    const current = object.pictures.find(item => item.id === picture.id);
    if (!current || pictureFile(current) !== pictureFile(picture) || !isCurrent()) return;
    const dimension = { ...current.dimension, width: payload.size.width,
      height: payload.size.height, entryVectorNativeCanvas: true, ...patch };
    delete dimension.entryVectorPivot;
    // 새 그림을 올렸으므로 아틀라스 칸은 더 이상 이 모양이 아니다(되살리기가 옛 칸을 다시 걸지 않게).
    if (!('entryVectorAtlas' in patch)) delete dimension.entryVectorAtlas;
    for (const key of Object.keys(dimension)) if (dimension[key] === undefined) delete dimension[key];
    Object.assign(saved, { id: current.id, name: current.name, objectId: object.id,
      imageType: payload.ext, dimension });
    delete saved.thumbUrl;
    // 픽셀 모양은 실행 화면이 SVG(pixelated)를 쓰도록 fileurl을 건다. 빠져도 k배 PNG가 남는다.
    if (payload.pixelSvg) saved.fileurl = svgFile(saved.filename);
    else delete saved.fileurl;
    window.Entry.playground.setPicture(saved);
    const fresh = object.pictures.find(item => item.id === saved.id);
    if (!fresh) return;
    // 모양 객체가 새로 바뀌므로, 옛 객체를 들고 있는 선택 모양·무대 그림·편집기도 새 것으로 맞춘다.
    if (object.selectedPicture?.id === fresh.id) object.selectedPicture = fresh;
    if (object.entity?.picture?.id === fresh.id) {
      object.entity.setImage(fresh);
      object.entity.setRegX(object.entity.getWidth() / 2);
      object.entity.setRegY(object.entity.getHeight() / 2);
      window.Entry.stage.updateObject();
    }
    const painter = window.Entry.playground.painter;
    if (painter?.file?.id === fresh.id && !painter.file.modified) painter.afterModified(fresh);
    // 엔트리 저장 처리는 여기서 그림을 미리 불러 두지만, 여러 개를 맞출 때 서버 요청이 몰려
    // 연결이 끊기는 데 보태므로 하지 않는다. 엔트리는 그림이 필요할 때 직접 불러온다.
  }
  async function runLimited(tasks, limit) {
    let next = 0;
    const worker = async () => { while (next < tasks.length) await tasks[next++](); };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  }
  function startUnify(object, common, skipId) {
    const generation = (unifyGeneration.get(object) || 0) + 1;
    unifyGeneration.set(object, generation);
    const isCurrent = () => unifyGeneration.get(object) === generation;
    const painter = window.Entry?.playground?.painter;
    const stage = painter?.entryPaint?.project && paintLayer(painter.entryPaint)?.stage;
    // 비트맵 모양은 편집기 캔버스가 무대 크기라 무대 안까지만 맞춘다. 픽셀 모양은 k배로 저장한다.
    const sizeOf = picture => {
      const half = picture.imageType === 'png' && stage ? {
        x: Math.min(common.x, Math.floor(stage.width / 2)),
        y: Math.min(common.y, Math.floor(stage.height / 2)) } : common;
      const k = pixelOf(picture) || 1;
      return { width: half.x * 2 * k, height: half.y * 2 * k };
    };
    const differs = (picture, size) => Math.abs(picture.dimension.width - size.width) > 0.5 ||
      Math.abs(picture.dimension.height - size.height) > 0.5;
    // 종류를 모르는 모양은 벡터를 비트맵으로 바꿔 올릴 수 있으므로 건드리지 않는다.
    const targets = object.pictures.filter(picture => picture.id !== skipId &&
      picture.dimension?.entryVectorNativeCanvas &&
      (picture.imageType === 'svg' || picture.imageType === 'png'));
    // 예전 방식(PNG만, SVG 없음)으로 저장된 픽셀 모양은 크기가 같아도 SVG 방식으로 다시 올린다.
    // 아틀라스 칸을 쓰는 모양은 이미 SVG로 그려진다.
    const needsSvg = picture => !!pixelOf(picture) && picture.imageType !== 'svg' && !atlasOf(picture);
    // 다시 올릴 모양이 많으면 저장 한 번에 서버 요청이 몰리므로 먼저 묻는다.
    const resizing = targets.filter(picture =>
      differs(picture, sizeOf(picture)) || needsSvg(picture)).length;
    if (resizing > 40 && !window.confirm(`공통 상자 크기가 바뀌어 다른 모양 ${resizing}개를 ` +
        '다시 저장해야 합니다. 지금 할까요? (취소하면 다음 저장 때 다시 묻습니다)')) return;
    const tasks = targets.map(picture => async () => {
      try {
        const size = sizeOf(picture);
        if (!(size.width > 0 && size.height > 0) || !isCurrent()) return;
        const pixel = pixelOf(picture);
        if (!differs(picture, size) && !needsSvg(picture) &&
            (pixel || await runtimePngMatches(picture))) return;
        if (pixel) {
          const payload = await resizedPixel(picture, size, pixel);
          if (isCurrent()) await uploadPicture(object, picture, payload, isCurrent);
          return;
        }
        const payload = picture.imageType === 'svg' ?
          await resizedSvg(picture, size) : await resizedPng(picture, size);
        if (isCurrent()) await uploadPicture(object, picture, payload, isCurrent);
      } catch (error) {
        console.warn('[entry-vector-rig] 공통 상자 맞추기 실패', picture.name, error);
      }
    });
    runLimited(tasks, 6);
  }

  // ---- 픽셀 아트 ----
  // 실행 화면 텍스처 최대 크기는 640×360(엔트리 EntryTextureOption)이다. 이보다 큰 모양은 엔트리가 중간
  // 캔버스에 보간하며 줄여 그리므로(_resizeIfNotValidSize) 픽셀 아트도 흐려진다.
  const pictureImage = picture =>
    loadImage(window.Entry.playground.painter.getImageSrc(picture));
  const canvasOfImage = image => {
    const canvas = canvasOfSize(image.naturalWidth || image.width, image.naturalHeight || image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  };
  // 픽셀 모양의 원래 해상도 그림. 대체용 k배 PNG(파일 이름)가 있으면 그것을 1/k로 줄인다.
  async function pixelArtOf(picture) {
    const k = pixelOf(picture) || 1;
    let image;
    try {
      if (!picture.filename) throw Error('파일 이름 없음');
      image = await loadImage(runtimePng(picture.filename));
    } catch { image = await loadImage(window.Entry.playground.painter.getImageSrc(picture)); }
    return scaledCanvas(image, Math.round(image.naturalWidth / k), Math.round(image.naturalHeight / k));
  }
  // 픽셀 모양 업로드 데이터. 엔트리 실행 화면은 보간을 끌 수 없지만, fileurl로 건 SVG 안의 PNG에
  // image-rendering:pixelated를 주면 크롬은 어떤 크기·위치에서도 각지게 그린다(시험 작품에서 섞인
  // 색 0%, 16배 PNG는 소수 위치에서 7~28%). SVG는 k배 크기로 표시하고, fileurl이 빠졌을 때를 위해
  // k배 PNG도 함께 올린다.
  function pixelSvg(art, k) {
    const png = art.toDataURL('image/png');
    const width = art.width * k, height = art.height * k;
    return `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" ` +
      `height="${height}" viewBox="0 0 ${art.width} ${art.height}"><image width="${art.width}" ` +
      `height="${art.height}" href="${png}" xlink:href="${png}" image-rendering="optimizeSpeed" ` +
      'style="image-rendering:pixelated"/></svg>';
  }
  function pixelPayload(art, k) {
    const width = art.width * k, height = art.height * k;
    return { ext: 'svg', svg: pixelSvg(art, k), pixelSvg: true, size: { width, height },
      image: scaledCanvas(art, width, height).toDataURL('image/png') };
  }
  // ---- 모양 불러오기 안정화 ----
  // 엔트리 편집기는 모양을 바꾸면 file.id를 먼저 새 모양으로 바꾸고(afterModified) 그림은 비동기로 불러온다
  // (entry-paint hC.import / importSVG). 그림이 도착해야 캔버스를 지우고 넣으며, 앞선 요청을 취소하지 않는다.
  // 그래서 (1) 도착 전에 저장하면 이전 모양 그림이 새 모양에 저장되고 (2) B를 누르고 곧 C를 누르면 늦게 온
  // B 그림이 C 자리에 들어가 "C를 고친 것"으로 기록된다(엔트리 SNAPSHOT_SAVED 처리가 modified를 켬). 다음
  // 저장이나 "저장할까요?"에서 C가 B 그림으로 덮인다. 시험 작품에서 모양을 바꾼 뒤 0~5ms 동안 file.id는 새
  // 모양인데 캔버스는 이전 그림인 것을 확인했다. 확장은 그림을 먼저 받아 두고 그때까지 마지막으로 고른
  // 모양일 때만 엔트리에 넘기며, 엔트리가 다 넣을 때까지(SNAPSHOT_SAVED) 저장을 막는다(ensureSaveHook).
  // 편집기는 픽셀 모양을 원래 해상도로 연다. 저장할 때 다시 k배로 키운다(ensureSaveHook).
  function ensureLoadHook(painter) {
    const proto = Object.getPrototypeOf(painter);
    if (proto.__entryVectorLoadHook || typeof proto.addPicture !== 'function') return;
    const original = proto.addPicture;
    Object.defineProperty(proto, '__entryVectorLoadHook', { value: true });
    proto.addPicture = function (picture = {}, isImport, ...rest) {
      // 모양 바꾸기(afterModified)만 두 번째 인자가 참이다. 다른 호출은 엔트리 그대로 둔다.
      if (!isImport) return original.call(this, picture, isImport, ...rest);
      const token = {};
      this.__evrLoadToken = token;
      this.__evrUnbaked = null;
      startLoading(this, token);
      const hand = ready => {
        if (this.__evrLoadToken !== token) return; // 그 사이 다른 모양을 골랐다: 이 그림은 버린다
        if (ready !== picture && pixelOf(picture)) this.__evrUnbaked = picture.id;
        try {
          original.call(this, ready, isImport, ...rest);
        } finally {
          waitImported(this, token); // 엔트리 쪽에서 예외가 나도 5초 안에는 저장 막힘을 푼다
        }
      };
      readyPicture(this, picture).then(hand, error => {
        console.warn('[entry-vector-rig] 모양 그림 미리 받기 실패', picture.name, error);
        hand(picture);
      });
    };
  }
  // 엔트리에 넘길 모양: 그림을 미리 받아 두고, 받은 그림을 바로 쓰도록 주소를 바꾼 사본(원래 모양은 그대로).
  async function readyPicture(painter, picture) {
    const k = pixelOf(picture);
    // 픽셀 모양(SVG·아틀라스 주소)도 비트맵으로, 원래 해상도 그림을 넣어 연다.
    if (k > 1) {
      const art = await pixelArtOf(picture);
      return { ...picture, imageType: 'png', fileurl: art.toDataURL('image/png') };
    }
    if (k === 1 && picture.filename) {
      const src = runtimePng(picture.filename); // 1배 픽셀 모양은 파일 PNG가 원래 그림이다
      await loadImage(src, true);
      return { ...picture, imageType: 'png', fileurl: src };
    }
    const src = painter.getImageSrc(picture);
    if (picture.imageType === 'svg') {
      // SVG는 글로 받아 넘긴다. paper importSVG는 첫 줄에 '<'가 있는 글을 바로 읽는다(주소면 다시 받는다).
      const response = await fetch(src, { credentials: 'same-origin' });
      if (!response.ok) throw Error(`SVG를 받을 수 없습니다 (${response.status})`);
      const text = (await response.text()).replace(/^\s+/, '');
      if (!/^[^\n]*</.test(text)) throw Error('SVG 글이 아닙니다.');
      return { ...picture, fileurl: text };
    }
    await loadImage(src, true); // 엔트리가 같은 주소를 다시 받을 때 캐시에서 온다
    return picture;
  }
  // 불러오는 동안은 저장을 막고, 0.15초 넘게 걸리면 편집기를 덮어 그리기도 막는다.
  function startLoading(painter, token) {
    painter.__evrLoading = token;
    clearTimeout(painter.__evrLoadingTimer);
    painter.__evrLoadingTimer = setTimeout(() => {
      if (painter.__evrLoading === token) showLoadingCover(painter, true);
    }, 150);
  }
  // 엔트리는 그림을 다 넣은 뒤 saveSnapshot → SNAPSHOT_SAVED를 낸다. 오지 않으면(그림 오류 등) 5초 뒤 푼다.
  function waitImported(painter, token) {
    const finish = () => {
      if (painter.__evrLoading !== token) return;
      painter.__evrLoading = null;
      clearTimeout(painter.__evrLoadingTimer);
      showLoadingCover(painter, false);
    };
    painter.entryPaint?.once?.('SNAPSHOT_SAVED', finish);
    setTimeout(finish, 5000);
  }
  function showLoadingCover(painter, on) {
    const area = painter.entryPaint?.project?.view?.element?.closest?.('.canvas_area');
    let cover = document.querySelector('.evr-load-cover');
    if (!on || !area) { cover?.remove(); return; }
    if (!cover) {
      cover = document.createElement('div');
      cover.className = 'evr-load-cover';
      cover.textContent = '모양 그림을 불러오는 중…';
    }
    if (cover.parentElement !== area) area.append(cover);
  }
  // .ent를 다시 열면 엔트리 서버가 fileurl을 빼고 돌려준다. SVG로 저장한 픽셀 모양은 새 파일
  // 이름으로도 서버에 SVG가 남아 있으므로(시험으로 확인) 주소만 다시 건다. 업로드는 하지 않고,
  // 확인 요청도 한 번에 2개까지만 보낸다.
  const svgChecks = new Map();
  let svgChecking = 0;
  // 아틀라스 칸을 쓰는 모양(imageType png)도 같은 방법으로 칸 주소를 다시 건다(아틀라스 파일로 확인).
  function restorePixelFileurls() {
    for (const object of window.Entry?.container?.getAllObjects?.() || []) {
      for (const picture of object.pictures || []) {
        const atlas = pixelOf(picture) ? atlasOf(picture) : null;
        let file, url;
        if (atlas) {
          ({ file } = atlas); url = atlasUrl(atlas);
          if (picture.fileurl === url) continue;
        } else {
          if (!pixelOf(picture) || picture.imageType !== 'svg' || !picture.filename) continue;
          file = picture.filename; url = svgFile(file);
          if (/\.svg(\?|$)/.test(picture.fileurl || '')) continue;
        }
        const state = svgChecks.get(file);
        if (state === 'ok') {
          picture.fileurl = url;
          if (object.entity?.picture?.id === picture.id) {
            object.entity.setImage(picture);
            window.Entry.stage.updateObject();
          }
        } else if (!state && svgChecking < 2) {
          svgChecking++;
          svgChecks.set(file, 'pending');
          fetch(svgFile(file)).then(response => svgChecks.set(file, response.ok ? 'ok' : 'missing'))
            .catch(() => svgChecks.delete(file))
            .finally(() => { svgChecking--; });
        }
      }
    }
  }
  // 확장이 켜져 있으면 픽셀 오브젝트(복제본 포함)는 무대에서 보간 없이 그린다.
  function ensurePixelDrawHook() {
    const proto = window.createjs?.Bitmap?.prototype;
    if (!proto || proto.__entryVectorPixelDraw || typeof proto.draw !== 'function') return;
    const original = proto.draw;
    Object.defineProperty(proto, '__entryVectorPixelDraw', { value: true });
    proto.draw = function (context, ignoreCache) {
      if (!pixelOf(this.entity?.picture)) return original.call(this, context, ignoreCache);
      const previous = context.imageSmoothingEnabled;
      context.imageSmoothingEnabled = false;
      try { return original.call(this, context, ignoreCache); }
      finally { context.imageSmoothingEnabled = previous; }
    };
  }
  // 편집기에서 픽셀 모양은 보간 없이 보이고, 반 픽셀에 걸치지 않도록 픽셀 격자에 맞춘다.
  function tidyPixelPainter(c) {
    if (!pixelOf(c.picture) || !bitmapMode(c)) return;
    const grid = editorScale(c);
    for (const item of c.layer.children) {
      if (item.className !== 'Raster') continue;
      if (item.smoothing !== 'off') item.smoothing = 'off';
      const dx = Math.round(item.bounds.left / grid) * grid - item.bounds.left;
      const dy = Math.round(item.bounds.top / grid) * grid - item.bounds.top;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)
        item.translate(new c.ep.paper.Point(dx, dy));
    }
  }
  // ---- 오브젝트 단위 픽셀 아트: 아틀라스 ----
  // 모양마다 SVG를 올리면 서버가 요청마다 0.13초 넘게 써서(동시 2개까지) 모양 500개에 수십 초가 걸렸다.
  // 같은 크기 모양들을 SVG 한 장에 칸으로 모아 한 번 올리고, 모양은 "아틀라스.svg#f번호"로 자기 칸만 본다.
  // 시험(2026-10-07, 시험 작품): 엔트리 무대에서 칸 SVG(1배·16배)가 여러 크기·소수 위치 모두 섞인 색 0%
  // (1배 PNG 98~99%, 16배 PNG 8~41%), 모양 목록 썸네일(CSS 배경)도 칸을 따름, 서버는 <view>를 그대로 보관.
  // 칸 표시: dimension.entryVectorAtlas = { file: 아틀라스 파일 이름, view: 'f번호', base?: 원래 fileurl }
  const atlasOf = picture => {
    const atlas = picture?.dimension?.entryVectorAtlas;
    return atlas && typeof atlas.file === 'string' && /^[\w-]{1,80}$/.test(atlas.file) &&
      typeof atlas.view === 'string' && /^f\d{1,6}$/.test(atlas.view) ? atlas : null;
  };
  const atlasUrl = atlas => `${svgFile(atlas.file)}#${atlas.view}`;
  // 아틀라스 한 장의 한 변 최대 길이(px). 서버가 너무 크다고 하면(413) 반씩 줄여 다시 나눈다.
  const ATLAS_SIDE = 2048;
  // 같은 크기 그림끼리 한 장에 칸으로 늘어놓는다(픽셀까지 같은 그림은 한 칸). arts는 비어 있는 자리가 있어도 된다.
  // 돌려주는 장: { width, height, columns, cells: [칸 그림], members: [[그림 번호, 칸 번호]…] }
  function packAtlases(arts, side = ATLAS_SIDE) {
    const groups = new Map();
    arts.forEach((art, index) => {
      if (!art) return;
      const size = `${art.width}x${art.height}`;
      if (!groups.has(size)) groups.set(size, []);
      groups.get(size).push(index);
    });
    const sheets = [];
    for (const indexes of groups.values()) {
      const { width, height } = arts[indexes[0]];
      const columns = Math.max(1, Math.floor(side / width)), rows = Math.max(1, Math.floor(side / height));
      const seen = new Map(); // 요약 → [{ data, sheet, cell }]
      let sheet = null;
      for (const index of indexes) {
        const { key, data } = artKey(arts[index]);
        const same = seen.get(key)?.find(entry => samePixels(entry.data, data));
        if (same) { same.sheet.members.push([index, same.cell]); continue; }
        if (!sheet || sheet.cells.length >= columns * rows) {
          sheet = { width, height, columns, cells: [], members: [] };
          sheets.push(sheet);
        }
        const cell = sheet.cells.length;
        sheet.cells.push(arts[index]);
        sheet.members.push([index, cell]);
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push({ data, sheet, cell });
      }
    }
    return sheets;
  }
  // 아틀라스 한 장을 SVG(칸마다 <view id="f번호">)로 올린다. 바깥 크기는 칸 크기의 k배라 엔트리는 모양
  // 크기(dimension)와 같은 그림으로 읽고 중간 캔버스(보간 켬)를 거치지 않는다. 함께 보내는 PNG는 첫 칸이다.
  async function uploadAtlas(sheet, k) {
    const { width, height, cells } = sheet, columns = Math.min(sheet.columns, cells.length);
    const canvas = canvasOfSize(columns * width, Math.ceil(cells.length / columns) * height);
    const context = canvas.getContext('2d');
    const places = cells.map((art, i) => ({ x: (i % columns) * width, y: Math.floor(i / columns) * height }));
    cells.forEach((art, i) => context.drawImage(art, places[i].x, places[i].y));
    const png = canvas.toDataURL('image/png');
    const svg = `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width * k}" ` +
      `height="${height * k}" viewBox="0 0 ${width} ${height}">` +
      places.map(({ x, y }, i) => `<view id="f${i}" viewBox="${x} ${y} ${width} ${height}"/>`).join('') +
      `<image width="${canvas.width}" height="${canvas.height}" href="${png}" xlink:href="${png}" ` +
      'image-rendering="optimizeSpeed" style="image-rendering:pixelated"/></svg>';
    const size = { width: width * k, height: height * k };
    const saved = await uploadPayload({ ext: 'svg', svg, size,
      image: scaledCanvas(cells[0], size.width, size.height).toDataURL('image/png') });
    return saved.filename;
  }
  // 그림들(원래 해상도 캔버스, 순서대로)을 아틀라스로 올리고 그림마다 칸 표시({ file, view })를 돌려준다.
  async function uploadAtlases(arts, k, onProgress) {
    const marks = new Array(arts.length);
    const pending = packAtlases(arts).map(sheet => ({ sheet, side: ATLAS_SIDE }));
    let done = 0, total = pending.length, failure = null;
    const worker = async () => {
      while (pending.length && !failure) {
        const { sheet, side } = pending.shift();
        try {
          const file = await uploadAtlas(sheet, k);
          for (const [index, cell] of sheet.members) marks[index] = { file, view: `f${cell}` };
          onProgress?.(++done, total);
        } catch (error) {
          if (error.status !== 413 || sheet.cells.length < 2 || side <= 256) { failure ||= error; return; }
          const subset = [];
          for (const [index] of sheet.members) subset[index] = arts[index];
          const smaller = packAtlases(subset, side / 2);
          total += smaller.length - 1;
          pending.push(...smaller.map(next => ({ sheet: next, side: side / 2 })));
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_SLOTS }, worker));
    if (failure) throw failure;
    return marks;
  }
  // 모양을 새 내용으로 바꿔 끼운다(엔트리 setPicture: 목록 그림·크기 표시도 바꿈). 그 사이 사용자가 그 모양을
  // 다시 저장했거나 지웠으면 건너뛴다. 건너뛴 개수를 돌려준다.
  function replacePictures(object, pictures, make) {
    let skipped = 0;
    pictures.forEach((picture, index) => {
      const current = object.pictures.find(item => item.id === picture.id);
      if (!current || pictureFile(current) !== pictureFile(picture) || current.fileurl !== picture.fileurl) {
        skipped++;
        return;
      }
      const next = make(current, index);
      delete next.view;
      next.objectId = object.id;
      window.Entry.playground.setPicture(next);
      const fresh = object.pictures.find(item => item.id === next.id);
      if (!fresh) return;
      if (object.selectedPicture?.id === fresh.id) object.selectedPicture = fresh;
      if (object.entity?.picture?.id === fresh.id) object.entity.setImage(fresh);
    });
    window.Entry.stage.updateObject();
    return skipped;
  }
  // 1배 픽셀 모양을 보통 모양으로: 파일 PNG가 원래 그림이므로 표시만 지운다(SVG로 저장한 모양도 같은 이름의
  // 1배 PNG가 함께 올라가 있다). 아틀라스 전에 쓰던 fileurl이 있었으면 되돌린다.
  function plainPicture(picture) {
    const next = { ...picture, imageType: 'png', dimension: { ...picture.dimension } };
    const atlas = atlasOf(picture);
    if (atlas?.base) next.fileurl = atlas.base; else delete next.fileurl;
    delete next.dimension.entryVectorPixel;
    delete next.dimension.entryVectorAtlas;
    return next;
  }
  // 모양 탭 "픽셀 아트" 켜기·끄기(오브젝트 단위).
  // - 켜기: 모양 그림을 6장씩 불러와 크기별 아틀라스로 올리고(보통 1번), 모양마다 칸 주소를 건다. 모양 PNG는
  //   다시 올리지 않고 오브젝트 크기도 그대로다. 아틀라스가 다 올라간 뒤 한꺼번에 반영한다(실패하면 그대로).
  // - 끄기(1배): 업로드 없이 표시만 지운다. 예전 k배 오브젝트는 원래 크기 PNG를 다시 올리고 크기를 k배로 되돌린다.
  let pixelBusy = false;
  async function setObjectPixel(object, enable) {
    if (pixelBusy) throw Error('픽셀 아트 변환이 이미 진행 중입니다.');
    const painter = window.Entry.playground.painter;
    if (painter?.file?.modified && object.pictures.some(picture => picture.id === painter.file.id))
      throw Error('저장하지 않은 변경 사항이 있습니다. 모양을 먼저 저장하세요.');
    pixelBusy = true;
    try {
      const k = objectPixel(object);
      if (!enable && k > 1) return await legacyPixelOff(object, k);
      if (!enable) {
        const skipped = replacePictures(object, object.pictures.filter(pixelOf), plainPicture);
        toast(`픽셀 아트를 껐습니다${skipped ? ` (그 사이 바뀐 모양 ${skipped}개는 그대로)` : ''} · 작품을 저장하세요`, 4000);
        return 0;
      }
      const pictures = object.pictures.slice();
      if (pictures.some(picture => picture.imageType === 'svg' && !pixelOf(picture)))
        throw Error('벡터 모양이 있는 오브젝트는 픽셀 아트로 바꿀 수 없습니다. 비트맵 모양만 남긴 뒤 다시 시도하세요.');
      const arts = new Array(pictures.length);
      let loaded = 0;
      await runLimited(pictures.map((picture, index) => async () => {
        arts[index] = canvasOfImage(await pictureImage(picture));
        toast(`픽셀 아트로 바꾸는 중… 그림 불러오기 ${++loaded}/${pictures.length}`);
      }), 6);
      const marks = await uploadAtlases(arts, 1, (done, total) =>
        toast(`픽셀 아트로 바꾸는 중… SVG 올리기 ${done}/${total}`));
      const skipped = replacePictures(object, pictures, (picture, index) => ({ ...picture,
        fileurl: atlasUrl(marks[index]), dimension: { ...picture.dimension, entryVectorPixel: 1,
          entryVectorAtlas: { ...marks[index], ...(picture.fileurl ? { base: picture.fileurl } : {}) } } }));
      toast(`픽셀 아트로 바꿨습니다${skipped ? ` (그 사이 바뀐 모양 ${skipped}개는 빼고)` : ''} · 작품을 저장하세요`, 4000);
      return 1;
    } catch (error) {
      toast(`픽셀 아트 변환 실패: ${error.message}`, 6000);
      throw error;
    } finally { pixelBusy = false; }
  }
  // 예전 방식(k배 PNG) 오브젝트 끄기: 원래 해상도 그림(k배 PNG를 1/k로 줄인 것)을 10장씩 묶어 올리고, 모두
  // 올라간 뒤 한꺼번에 반영한다(하나라도 실패하면 아무것도 바꾸지 않음 — 일부만 바뀌면 크기가 맞지 않음).
  async function legacyPixelOff(object, k) {
    const entity = object.entity, pictures = object.pictures.filter(pixelOf);
    const verb = '픽셀 아트를 끄는 중';
    const arts = new Array(pictures.length);
    let loaded = 0;
    await runLimited(pictures.map((picture, index) => async () => {
      arts[index] = await pixelArtOf(picture);
      toast(`${verb}… 그림 불러오기 ${++loaded}/${pictures.length}`);
    }), 6);
    const uploaded = new Array(pictures.length);
    let sent = 0;
    await uploadArts({ indexes: pictures.map((picture, index) => index), artAt: index => arts[index],
      state: {}, onSaved(index, saved) {
        uploaded[index] = saved;
        toast(`${verb}… 올리기 ${++sent}/${pictures.length}`);
      } });
    pictures.forEach((picture, index) => {
      const art = arts[index];
      applyUploaded(object, picture, uploaded[index], { ext: 'png',
        size: { width: art.width, height: art.height } }, { entryVectorPixel: undefined });
    });
    entity.setScaleX(entity.getScaleX() * k);
    entity.setScaleY(entity.getScaleY() * k);
    window.Entry.stage.updateObject();
    toast('픽셀 아트를 껐습니다 · 작품을 저장하세요', 4000);
    return 0;
  }
  // 픽셀 오브젝트에 새로 들어온 비트맵 모양(모양 가져오기 등)은 같은 k로 키워 맞춘다. 처음 본
  // 모양 목록은 건드리지 않아, 저장 중 표시가 빠진 기존 모양을 두 번 키우는 일을 막는다.
  const knownPictures = new WeakMap();
  function adoptPixelPictures(object) {
    if (!object) return;
    const k = objectPixel(object);
    if (!k) { knownPictures.delete(object); return; }
    const known = knownPictures.get(object);
    if (!known) { knownPictures.set(object, new Set(object.pictures.map(picture => picture.id))); return; }
    for (const picture of object.pictures) {
      if (known.has(picture.id)) continue;
      known.add(picture.id);
      if (pixelOf(picture)) continue;
      if (picture.imageType !== 'png') {
        console.warn('[entry-vector-rig] 픽셀 오브젝트에 벡터 모양이 들어왔습니다. 크기가 1/k로 보입니다.', picture.name);
        continue;
      }
      pictureImage(picture).then(async image => {
        const source = canvasOfImage(image), payload = pixelPayload(source, k);
        applyUploaded(object, picture, await uploadPayload(payload), payload,
          { entryVectorPixel: k, entryVectorArt: artOfCanvas(source) });
      }).catch(error => console.warn('[entry-vector-rig] 새 모양 픽셀 맞추기 실패', picture.name, error));
    }
  }
  // ---- 스프라이트 나누기 ----
  // 유니티 스프라이트 에디터처럼 별도 창에서 자동(투명 배경 기준)·칸 크기·칸 개수로 자르고, 미리보기에서
  // 영역을 직접 고친(고르기·옮기기·크기 바꾸기·새로 그리기·합치기·다시 나누기) 뒤 모양으로 만든다.
  // 자동 자르기는 유니티 문서가 설명하는 동작(주변 투명도로 경계를 찾고 최소 크기로 자잘한 조각을 거름)을
  // 따라 만든 것이다. 유니티 내부 구현은 공개되지 않았다.
  const opaqueAt = (pixels, index) => pixels[index * 4 + 3] > FAINT_ALPHA;
  // 투명 배경 시트에서 스프라이트 영역을 찾는다(region 안만, 시트 좌표로 돌려줌).
  // 1) 알파가 FAINT_ALPHA보다 큰 픽셀을 8방향으로 이은 덩어리를 찾는다.
  // 2) 픽셀 수가 기준(상위 20% 지점)의 1/5보다 작거나 최소 크기보다 작은 덩어리는 "작은 조각"(눈·발처럼
  //    본체에서 떨어진 부분)으로 보고, 나머지("본체")의 보통 너비·높이(중간값)를 잰다.
  // 3) 가까운 것부터 합친다. 작은 조각은 max(합칠 거리, 3px) 안의 본체에, 그 밖의 짝(본체끼리, 작은 조각끼리)은
  //    합칠 거리 안에서만(기본 0 = 사각형이 닿거나 겹칠 때) 합친다. 단 합친 사각형이 보통 크기의 1.25배
  //    (합칠 거리를 늘렸으면 2배)를 넘고 큰 쪽보다 15% 넘게 커지면 합치지 않는다. 예전에는 사각형이 겹치기만
  //    하면 합쳐서, 팔·가시가 옆 스프라이트 사각형 안으로 뻗은 촘촘한 시트에서 이웃을 같이 잘랐다.
  //    split이면(선택 영역 다시 나누기) 본체끼리는 합치지 않는다.
  // 4) 최소 크기보다 작은 덩어리는 잡티로 버리고, 위→아래·왼쪽→오른쪽 순서로 돌려준다.
  function detectSprites(pixels, width, region, { minSize = 4, gap = 0, split = false } = {}) {
    const { x: rx, y: ry, w: rw, h: rh } = region;
    const seen = new Uint8Array(rw * rh), stack = new Int32Array(rw * rh);
    const opaque = (x, y) => pixels[((ry + y) * width + rx + x) * 4 + 3] > FAINT_ALPHA;
    const parts = [];
    for (let start = 0; start < rw * rh; start++) {
      if (seen[start]) continue;
      const sx = start % rw, sy = (start - sx) / rw;
      if (!opaque(sx, sy)) continue;
      let top = 0, left = sx, right = sx, upper = sy, lower = sy, count = 0;
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const index = stack[--top], x = index % rw, y = (index - x) / rw;
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < upper) upper = y;
        if (y > lower) lower = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= rh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, next = ny * rw + nx;
            if (nx < 0 || nx >= rw || seen[next] || !opaque(nx, ny)) continue;
            seen[next] = 1; stack[top++] = next;
          }
        }
      }
      parts.push({ x: rx + left, y: ry + upper, w: right - left + 1, h: lower - upper + 1, count });
    }
    if (!parts.length) return [];
    const median = list => list.slice().sort((a, b) => a - b)[list.length >> 1];
    // 기준 크기: 픽셀 수의 상위 20% 지점. 중간값을 쓰면 떨어진 조각(발·눈)이 스프라이트보다 많을 때
    // 조각 크기가 기준이 돼 조각을 본체로 잘못 본다.
    const sized = parts.filter(part => Math.max(part.w, part.h) >= minSize);
    const counts = (sized.length ? sized : parts).map(part => part.count).sort((a, b) => a - b);
    const referenceCount = counts[Math.floor(counts.length * 0.8)] ?? counts[counts.length - 1];
    const small = box => box.count < referenceCount * 0.2 || Math.max(box.w, box.h) < minSize;
    const mains = parts.filter(part => !small(part));
    const typical = { w: median((mains.length ? mains : parts).map(part => part.w)),
      h: median((mains.length ? mains : parts).map(part => part.h)) };
    const limit = gap > 0 ? 2 : 1.25;
    const distance = (a, b) => Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w),
      b.y - (a.y + a.h), a.y - (b.y + b.h));
    const reach = (a, b) => small(a) !== small(b) ? Math.max(gap, 3) :
      !small(a) && split ? -1 : gap;
    // 후보 짝: x로 정렬해 멀리 떨어진 짝은 건너뛴다.
    const farthest = Math.max(gap, 3), order = parts.map((part, i) => i).sort((a, b) => parts[a].x - parts[b].x);
    const pairs = [];
    for (let a = 0; a < order.length; a++) {
      const pa = parts[order[a]];
      for (let b = a + 1; b < order.length; b++) {
        const pb = parts[order[b]];
        if (pb.x - (pa.x + pa.w) > farthest) break;
        const d = distance(pa, pb);
        if (d <= farthest) pairs.push({ i: order[a], j: order[b], d });
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    const owner = parts.map((part, i) => i), box = parts.map(part => ({ ...part }));
    const find = i => { while (owner[i] !== i) i = owner[i] = owner[owner[i]]; return i; };
    for (const { i, j } of pairs) {
      const a = find(i), b = find(j);
      if (a === b) continue;
      const A = box[a], B = box[b];
      if (distance(A, B) > reach(A, B)) continue;
      const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y);
      const union = { x, y, w: Math.max(A.x + A.w, B.x + B.w) - x, h: Math.max(A.y + A.h, B.y + B.h) - y,
        count: A.count + B.count };
      const big = A.count >= B.count ? A : B;
      const fits = union.w <= typical.w * limit && union.h <= typical.h * limit;
      const barelyGrows = union.w <= big.w * 1.15 && union.h <= big.h * 1.15;
      if (!fits && !barelyGrows) continue;
      owner[b] = a; box[a] = union;
    }
    const rects = parts.map((part, i) => i).filter(i => find(i) === i).map(i => box[i])
      .filter(rect => Math.max(rect.w, rect.h) >= minSize).map(({ x, y, w, h }) => ({ x, y, w, h }));
    return readingOrder(rects);
  }
  // 읽는 순서: 세로로 겹치는 조각끼리 한 줄로 묶어 위→아래, 줄 안에서는 왼쪽→오른쪽.
  function readingOrder(rects) {
    const lines = [];
    for (const rect of rects.slice().sort((a, b) => a.y - b.y)) {
      const line = lines.find(item => rect.y < item.bottom && rect.y + rect.h > item.top);
      if (line) { line.rects.push(rect); line.bottom = Math.max(line.bottom, rect.y + rect.h); }
      else lines.push({ top: rect.y, bottom: rect.y + rect.h, rects: [rect] });
    }
    return lines.flatMap(line => line.rects.sort((a, b) => a.x - b.x));
  }
  const sheetPixels = sheet => sheet.getContext('2d').getImageData(0, 0, sheet.width, sheet.height).data;
  // ---- 이웃 모양 겹쳐 맞추기(모양 맞추기 창의 "자동 맞춤") ----
  // 조각(모양)마다 기준점(회전 중심이 될 점)을 정해 같은 크기 틀의 가운데에 둔다. 같은 규칙(상자 아래 가운데 등)만
  // 쓰면 팔·다리가 뻗은 조각에서 몸이 흔들린다. 그래서 바로 앞 조각에 가장 잘 겹치는 위치를 찾아 기준점을 이어 준다.
  // 소닉 시트(497조각)로 잰 이웃 조각 불투명 영역 IoU: 상자 아래 가운데 0.702(2px 넘게 어긋난 짝 28%), 픽셀 무게중심
  // +발 0.717(22%), 바로 앞 조각에 겹쳐 맞추기 0.746(4%, ±8px 최적 0.747). 다만 바로 앞에만 맞추면 5칸 넘게 떨어진
  // 프레임끼리는 무게중심 규칙보다 조금 나빠져(떠내려감), 앞 4개까지 가중치를 두고 함께 맞춘다. 같은 시트 k칸 떨어진
  // 프레임 IoU(k=1, 4, 8): 상자 비율 0.707/0.607/—, 무게중심 규칙 0.721/0.622/0.566, 앞 4개 맞추기 0.746/0.638/0.574.
  // 기준점은 늘 규칙 기준점에서 ±9px 안이다.
  const ALIGN_REACH = 8, ALIGN_WEIGHTS = [1, .7, .5, .3]; // 바로 앞, 두 칸 앞 … 프레임에 겹치는 정도의 가중치
  // 그림 한 칸의 불투명 표시(옅은 기준점 픽셀 제외).
  function alphaItem(pixels, width, rect) {
    const alpha = new Uint8Array(rect.w * rect.h);
    let count = 0;
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        if (!opaqueAt(pixels, (rect.y + y) * width + rect.x + x)) continue;
        alpha[y * rect.w + x] = 1; count++;
      }
    }
    return { w: rect.w, h: rect.h, alpha, count };
  }
  // items[i]: { w, h, alpha, count }, base(i): 규칙 기준점 [x, y], linkable(i, j): 이어 맞출 수 있는 짝인가(크기 비슷·
  // 픽셀 30개 넘음은 여기서 따로 본다). 규칙 기준점에서 ±8px(2px 간격 → 둘레 1px)을 찾아, 이어진 앞 프레임들(최대 4개)에
  // 가중치를 두고 가장 잘 겹치는 곳으로 옮긴다(바로 앞 조각과 겹침이 0.4 이상일 때만). 기준점은 정수 px다(픽셀 그림이
  // 반 칸에 걸치지 않게).
  function alignAnchors(items, base, linkable) {
    const rule = items.map((item, i) => base(i).map(Math.round));
    const anchors = rule.map(point => point.slice()), linked = new Array(items.length).fill(false);
    const overlap = (a, b, dx, dy) => { // b를 (dx, dy) 옮겨 a에 겹쳤을 때 IoU
      let inter = 0;
      const x0 = Math.max(0, -dx), x1 = Math.min(b.w, a.w - dx);
      for (let y = Math.max(0, -dy); y < Math.min(b.h, a.h - dy); y++) {
        const rowA = (y + dy) * a.w + dx, rowB = y * b.w;
        for (let x = x0; x < x1; x++) if (b.alpha[rowB + x] && a.alpha[rowA + x]) inter++;
      }
      return inter / (a.count + b.count - inter);
    };
    const similar = (a, b) => Math.max(a.w, b.w) / Math.min(a.w, b.w) <= 1.5 &&
      Math.max(a.h, b.h) / Math.min(a.h, b.h) <= 1.5;
    for (let j = 1; j < items.length; j++) {
      const i = j - 1, a = items[i], b = items[j];
      if (a.count <= 30 || b.count <= 30 || !similar(a, b) || !linkable(i, j)) continue;
      linked[j] = true;
      const previous = []; // [프레임, 가중치]: 바로 앞부터 끊기지 않고 이어진 것만
      for (let t = 0; t < ALIGN_WEIGHTS.length && j - 1 - t >= 0; t++) {
        previous.push([j - 1 - t, ALIGN_WEIGHTS[t]]);
        if (!linked[j - 1 - t]) break;
      }
      // j의 기준점을 규칙 기준점에서 (ox, oy) 옮겼을 때 앞 프레임들과의 가중 평균 겹침
      const shiftTo = (p, ox, oy) => [anchors[p][0] - rule[j][0] - ox, anchors[p][1] - rule[j][1] - oy];
      const score = (ox, oy) => {
        let sum = 0, weight = 0;
        for (const [p, w] of previous) { sum += w * overlap(items[p], b, ...shiftTo(p, ox, oy)); weight += w; }
        return sum / weight;
      };
      let best = score(0, 0), at = [0, 0];
      const tryAt = (ox, oy) => {
        const value = score(ox, oy);
        if (value > best + 1e-9) { best = value; at = [ox, oy]; }
      };
      for (let oy = -ALIGN_REACH; oy <= ALIGN_REACH; oy += 2)
        for (let ox = -ALIGN_REACH; ox <= ALIGN_REACH; ox += 2) tryAt(ox, oy);
      const [cx, cy] = at;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) tryAt(cx + ox, cy + oy);
      if ((at[0] || at[1]) && overlap(a, b, ...shiftTo(i, ...at)) >= .4)
        anchors[j] = [rule[j][0] + at[0], rule[j][1] + at[1]];
    }
    return anchors;
  }
  function gridRects(sheet, options) {
    const { width, height } = sheet;
    const offsetX = Math.max(0, options.offsetX | 0), offsetY = Math.max(0, options.offsetY | 0);
    const padX = Math.max(0, options.padX | 0), padY = Math.max(0, options.padY | 0);
    let columns, rows, cellWidth, cellHeight;
    if (options.mode === 'count') {
      columns = Math.max(1, options.columns | 0); rows = Math.max(1, options.rows | 0);
      cellWidth = Math.floor((width - offsetX - padX * (columns - 1)) / columns);
      cellHeight = Math.floor((height - offsetY - padY * (rows - 1)) / rows);
    } else {
      cellWidth = Math.max(1, options.cellWidth | 0); cellHeight = Math.max(1, options.cellHeight | 0);
      columns = Math.floor((width - offsetX + padX) / (cellWidth + padX));
      rows = Math.floor((height - offsetY + padY) / (cellHeight + padY));
    }
    if (!(cellWidth > 0 && cellHeight > 0 && columns > 0 && rows > 0)) return [];
    const pixels = sheet.getContext('2d').getImageData(0, 0, width, height).data;
    const rects = [];
    for (let row = 0; row < rows && rects.length < 1000; row++) {
      for (let column = 0; column < columns; column++) {
        const rect = { x: offsetX + column * (cellWidth + padX), y: offsetY + row * (cellHeight + padY),
          w: cellWidth, h: cellHeight };
        let empty = true;
        for (let y = rect.y; y < rect.y + rect.h && empty; y++) {
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            if (opaqueAt(pixels, y * width + x)) { empty = false; break; }
          }
        }
        if (!empty || options.keepEmpty) rects.push(rect);
      }
    }
    return rects;
  }
  // 모든 조각을 같은 크기 틀에 넣는다. 고른 비율(pivot)의 점은 조각끼리 맞추는 기준으로만 쓰고(모든 조각의 그 점이 틀의
  // 같은 자리), 틀은 맞춘 조각 전체를 감싸는 크기라 엔트리 회전 중심(틀 가운데)은 조각 전체의 가운데가 된다. 예전에는 그
  // 점을 틀 가운데(회전 중심)에 두어, "아래"를 고르면 틀이 키의 2배가 되고 그림이 위쪽 절반에 떠 있었다(사용자 요청으로
  // 바꿈). 기준점은 정수 px(픽셀 그림이 반 칸에 걸치지 않게), 틀 너비·높이는 짝수(회전 중심도 정수 px)다.
  const anchorOf = (rect, pivot) => [Math.round(rect.w * pivot.x), Math.round(rect.h * pivot.y)];
  function frameLayout(rects, pivot, margin) {
    let left = 0, right = 0, top = 0, bottom = 0;
    for (const rect of rects) {
      const [x, y] = anchorOf(rect, pivot);
      left = Math.max(left, x); right = Math.max(right, rect.w - x);
      top = Math.max(top, y); bottom = Math.max(bottom, rect.h - y);
    }
    const width = left + right + 2 * margin, height = top + bottom + 2 * margin;
    return { x: margin + left, y: margin + top, size: { width: width + width % 2, height: height + height % 2 } };
  }
  // 조각 하나를 틀에 그린다. 올리기 직전에 만들어, 조각이 많아도 첫 업로드가 바로 시작되게 한다.
  function frameCanvas(sheet, rect, pivot, layout) {
    const frame = canvasOfSize(layout.size.width, layout.size.height);
    const context = frame.getContext('2d');
    const [x, y] = anchorOf(rect, pivot);
    context.imageSmoothingEnabled = false;
    context.drawImage(sheet, rect.x, rect.y, rect.w, rect.h, layout.x - x, layout.y - y, rect.w, rect.h);
    context.fillStyle = 'rgba(0, 0, 0, 0.01)';
    for (const [x, y] of cornersOf(layout.size)) context.fillRect(x, y, 2, 2);
    return frame;
  }
  // 묶음 업로드 파일(PNG).
  async function frameFile(frame, index) {
    const blob = await new Promise((resolve, reject) => frame.toBlob(result =>
      result ? resolve(result) : reject(Error('조각 그림을 만들 수 없습니다.')), 'image/png'));
    return new File([blob], `evr_${index}.png`, { type: 'image/png' });
  }
  // 낱장 업로드(/rest/picture/canvas) 데이터(PNG).
  const framePayload = frame =>
    ({ ext: 'png', size: { width: frame.width, height: frame.height }, image: frame.toDataURL('image/png') });
  // 업로드 응답에서 모양에 필요한 것만 담는다(응답에는 접속 정보 같은 다른 항목도 섞여 온다).
  // atlas가 있으면 픽셀 모양: 실행 화면은 아틀라스 칸(SVG, pixelated)을 쓴다.
  function pictureOf(saved, art, size, pixel, atlas) {
    const picture = { filename: saved.filename, imageType: 'png',
      dimension: { width: size.width, height: size.height, entryVectorNativeCanvas: true,
        entryVectorArt: art, ...(pixel ? { entryVectorPixel: pixel } : {}),
        ...(atlas ? { entryVectorAtlas: atlas } : {}) } };
    if (atlas) picture.fileurl = atlasUrl(atlas);
    return picture;
  }
  // 같은 그림인지 가르는 요약(크기 + 픽셀 해시). 요약이 같으면 픽셀을 끝까지 비교해 확정한다.
  function artKey(art) {
    const data = art.getContext('2d').getImageData(0, 0, art.width, art.height).data;
    let h = 2166136261;
    for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
    return { key: `${art.width}x${art.height}:${(h >>> 0).toString(36)}`, data };
  }
  const samePixels = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  // 그림 여러 장을 PNG로 올린다(스프라이트 나누기와 예전 픽셀 아트 끄기가 함께 쓴다). artAt(i)는 i번째 그림
  // (캔버스)이다. 올라갈 때마다 onSaved(i, 응답, 그림)를 부른다(앞에서부터, 동시 UPLOAD_SLOTS개).
  // state.cancelled가 서면 더 보내지 않는다.
  // - 픽셀이 똑같은 그림은 한 번만 올리고 같은 파일을 같이 쓴다(엔트리 모양 복제도 같은 파일을 가리킨다).
  // - 10장씩 묶어 보낸다. 묶음 응답에서 빠진 것은 낱장으로, 묶음 길을 쓸 수 없으면(주소가 없어짐 등) 모두
  //   낱장으로 보낸다(state.batch에 기억). 픽셀 아트의 SVG는 따로 아틀라스로 올린다(uploadAtlases).
  async function uploadArts({ indexes, artAt, state, onSaved }) {
    const chunks = [];
    for (let i = 0; i < indexes.length; i += BATCH_FILES) chunks.push(indexes.slice(i, i + BATCH_FILES));
    const uploads = new Map(); // 요약 → [{ data, promise }]: 이미 올리기 시작한 그림
    let failure = null;
    await runLimited(chunks.map(chunk => async () => {
      if (failure || state.cancelled) return;
      try {
        const own = [], copies = [];
        for (const index of chunk) {
          const art = artAt(index), { key, data } = artKey(art);
          const same = uploads.get(key)?.find(entry => samePixels(entry.data, data));
          if (same) { copies.push({ index, art, entry: same }); continue; }
          const item = { index, art };
          const entry = { data, promise: new Promise((resolve, reject) =>
            Object.assign(item, { resolve, reject })) };
          entry.promise.catch(() => {});
          if (!uploads.has(key)) uploads.set(key, []);
          uploads.get(key).push(entry);
          own.push(item);
        }
        const done = item => (saved => { item.resolve(saved); onSaved(item.index, saved, item.art); });
        try {
          const sent = new Set();
          if (state.batch !== false && own.length) {
            const files = await Promise.all(own.map(item => frameFile(item.art, item.index)));
            let saved = null;
            try { saved = await uploadBatch(files); }
            catch (error) { if (!error.unsupported) throw error; state.batch = false; }
            if (saved) own.forEach((item, i) => {
              const found = saved.get(files[i].name);
              if (found) { done(item)(found); sent.add(item); }
            });
          }
          for (const item of own) {
            if (sent.has(item)) continue;
            if (failure || state.cancelled) throw Error('업로드를 멈췄습니다.');
            done(item)(await uploadPayload(framePayload(item.art)));
          }
        } catch (error) { own.forEach(item => item.reject(error)); throw error; }
        for (const { index, art, entry } of copies) onSaved(index, { ...await entry.promise }, art);
      } catch (error) { failure ||= error; }
    }), UPLOAD_SLOTS);
    if (failure) throw failure;
  }
  // 조각을 앞에서부터 올린다. 올린 결과는 job.results에 남아, 실패한 뒤 다시 부르면 남은 조각만 올린다.
  // 픽셀 아트(job.pixel = k)는 먼저 조각 전체를 아틀라스 SVG로 올리고(보통 1번), 조각 PNG(k배)는 일반 조각과
  // 같이 10장씩 묶어 올린다. 조각마다 SVG를 올리던 때보다 서버 요청이 조각 수만큼 줄었다.
  async function uploadFrames(job, onProgress) {
    const layout = frameLayout(job.rects, job.pivot, job.pixel ? PIXEL_MARGIN : MARGIN);
    const k = job.pixel || 1;
    const size = { width: layout.size.width * k, height: layout.size.height * k };
    const frameAt = index => frameCanvas(job.sheet, job.rects[index], job.pivot, layout);
    const done = () => job.results.filter(Boolean).length;
    try {
      if (job.pixel && !job.atlas) {
        onProgress(done(), job.rects.length, '픽셀 아트 SVG');
        job.atlas = await uploadAtlases(job.rects.map((rect, index) => frameAt(index)), k);
      }
      onProgress(done(), job.rects.length);
      await uploadArts({ indexes: job.rects.map((rect, index) => index).filter(index => !job.results[index]),
        artAt: index => k > 1 ? scaledCanvas(frameAt(index), size.width, size.height) : frameAt(index),
        state: job, onSaved(index, saved, art) {
          // 그림 퍼짐 기록은 그림 단위(원래 픽셀)다.
          job.results[index] = pictureOf(saved, artOfCanvas(k > 1 ? frameAt(index) : art), size,
            job.pixel, job.atlas?.[index]);
          onProgress(done(), job.rects.length);
        } });
    } catch (failure) { throw Object.assign(failure, { done: done() }); }
    return job.results.map(copy);
  }
  // 모양 여러 개를 한 번에 넣는다. 엔트리 addPicture는 하나 넣을 때마다 모양 목록 전체를 다시 그려
  // 개수가 늘수록 느려진다(빈 작품 시험: 100개 3.3초, 그다음 100개 7.8초 / 한 번에 300개 72ms).
  // 되돌리기는 엔트리 되돌리기 기록에 한 단계로 넣는다(다시 하기는 같은 모양을 다시 넣음).
  const passOf = state => ({ isPass: value => { if (state) state.isPass = value; } });
  function addPicturesBatch(objectId, pictures) {
    const E = window.Entry, object = E.container.getObject(objectId);
    if (!object) return passOf(null);
    for (const picture of pictures) {
      delete picture.view;
      picture.id ||= E.generateHash(); // 엔트리 addPicture처럼 id를 붙인다(되돌리기·선택이 id로 찾음)
      picture.objectId = objectId;
      if (object.pictures.some(item => item.name === picture.name))
        picture.name = E.getOrderedName(picture.name, object.pictures);
      object.pictures.push(picture);
    }
    if (E.playground.object === object) E.playground.injectPicture(false);
    return passOf(E.stateManager?.addCommand('evr add pictures', null, removePicturesBatch,
      objectId, pictures));
  }
  function removePicturesBatch(objectId, pictures) {
    const E = window.Entry, object = E.container.getObject(objectId);
    const ids = new Set(pictures.map(picture => picture.id));
    if (!object || object.pictures.every(picture => ids.has(picture.id))) return passOf(null);
    if (ids.has(object.selectedPicture?.id))
      E.playground.selectPicture(object.pictures.find(picture => !ids.has(picture.id)), true);
    // 엔트리가 들고 있는 모양 배열을 바꿔 끼우지 않고 그 자리에서 뺀다.
    for (let i = object.pictures.length - 1; i >= 0; i--)
      if (ids.has(object.pictures[i].id)) object.pictures.splice(i, 1);
    if (E.playground.object === object) E.playground.injectPicture(false);
    return passOf(E.stateManager?.addCommand('evr remove pictures', null, addPicturesBatch,
      objectId, pictures));
  }
  // 조각들을 모양으로 가진 새 오브젝트. 엔트리 오브젝트 추가 명령이라 되돌리기가 되고, 열려 있는
  // 오브젝트 추가하기 창도 닫힌다. 처음 크기는 엔트리 기본(그림 크기에 맞춤)을 따른다.
  function addSheetObject(name, pictures) {
    const E = window.Entry, id = E.generateHash();
    pictures.forEach(picture => { picture.id = E.generateHash(); picture.objectId = id; });
    E.container.addObject({ id, objectType: 'sprite', rotateMethod: 'free',
      scene: E.scene.selectedScene.id, selectedPictureId: pictures[0].id,
      sprite: { name, pictures, sounds: [], category: {} } });
    return E.container.getObject(id);
  }
  // 화면 왼쪽 아래 작은 진행 표시. hideAfter(ms)가 있으면 그 뒤 사라진다.
  let toastTimer = 0;
  function toast(message, hideAfter) {
    let node = document.querySelector('.evr-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'evr-toast';
      node.setAttribute('role', 'status');
      document.body.append(node);
    }
    node.textContent = message;
    clearTimeout(toastTimer);
    if (hideAfter) toastTimer = setTimeout(() => node.remove(), hideAfter);
  }
  // 올리는 도중에 앞쪽부터 올라온 모양을 이미 만든 묶음 뒤에 이어 붙인다(되돌리기는 처음 한 단계 그대로).
  // 모양 탭: list(addPicturesBatch의 되돌리기 목록)에도 더해 되돌리기·다시하기가 전부를 함께 다룬다.
  // 새 오브젝트: 오브젝트 추가 명령을 되돌리면 통째로 빠지고, 다시 하기는 되돌린 때의 오브젝트로 돌아온다.
  // 그 사이 오브젝트나 처음 묶음이 지워졌으면 false를 돌려준다(남은 업로드를 멈춤).
  function appendPictures(object, more, list) {
    const E = window.Entry;
    if (E.container.getObject(object.id) !== object) return false;
    if (list && !object.pictures.some(picture => picture.id === list[0]?.id)) return false;
    for (const picture of more) {
      delete picture.view;
      picture.id ||= E.generateHash();
      picture.objectId = object.id;
      if (object.pictures.some(item => item.name === picture.name))
        picture.name = E.getOrderedName(picture.name, object.pictures);
      object.pictures.push(picture);
      list?.push(picture);
    }
    if (E.playground.object === object) E.playground.injectPicture(false);
    return true;
  }
  // 모양 여러 개를 같은 id 자리에 한꺼번에 바꿔 끼운다. 되돌리기 한 단계로 이전 모양들로 돌아간다(다시 하기도 같은 길).
  // 엔트리 container.setPicture는 받은 객체에서 몇 필드만 골라 새 객체로 넣으므로(objectId는 빠짐) id로 찾는다.
  function setPicturesBatch(objectId, pictures) {
    const E = window.Entry, object = E.container.getObject(objectId);
    if (!object) return passOf(null);
    const previous = [];
    for (const picture of pictures) {
      const current = object.pictures.find(item => item.id === picture.id);
      if (!current) continue;
      previous.push(current);
      delete picture.view;
      picture.objectId = objectId;
      E.playground.setPicture(picture);
    }
    const now = id => object.pictures.find(item => item.id === id);
    const changed = new Set(pictures.map(picture => picture.id));
    if (object.selectedPicture && now(object.selectedPicture.id)) object.selectedPicture = now(object.selectedPicture.id);
    const shown = object.entity?.picture && now(object.entity.picture.id);
    if (shown && changed.has(shown.id)) {
      object.entity.setImage(shown);
      object.entity.setRegX(object.entity.getWidth() / 2);
      object.entity.setRegY(object.entity.getHeight() / 2);
    }
    E.stage.updateObject();
    // 편집기에 열린 모양이면 바뀐 그림으로 다시 연다(고치는 중이면 그대로 둔다).
    const painter = E.playground.painter, open = painter?.file?.id && now(painter.file.id);
    if (open && changed.has(open.id) && !painter.file.modified) painter.afterModified(open);
    return passOf(E.stateManager?.addCommand('evr set pictures', null, setPicturesBatch, objectId, previous));
  }
  // 모양 그림에서 그림 부분(옅은 기준점 픽셀 제외)만 잘라 낸 표시. 비어 있으면 그림 전체.
  function trimmedItem(art) {
    const { width, height } = art, pixels = art.getContext('2d').getImageData(0, 0, width, height).data;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!opaqueAt(pixels, y * width + x)) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
    const rect = right < 0 ? { x: 0, y: 0, w: width, h: height } :
      { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    return { ...alphaItem(pixels, width, rect), rect };
  }
  // ---- 모양 다시 맞추기(중심 맞추기·모양 맞추기 창 공용) ----
  // 오브젝트의 비트맵·픽셀 모양을 모두 원래 해상도로 불러와 그림 부분만 잘라 둔다(벡터 모양은 빼고).
  // anchors[i]: 잘라 낸 그림 안에서 회전 중심이 될 점. 처음에는 지금 회전 중심(그림 가운데)이다.
  let alignBusy = false;
  async function loadPictureFrames(object, verb) {
    const painter = window.Entry.playground.painter;
    if (painter?.file?.modified && object.pictures.some(picture => picture.id === painter.file.id))
      throw Error('저장하지 않은 변경 사항이 있습니다. 모양을 먼저 저장하세요.');
    const pictures = object.pictures.filter(picture => pixelOf(picture) || picture.imageType !== 'svg');
    if (pictures.length < 2) throw Error('비트맵 모양이 두 개 이상 있어야 합니다(벡터 모양은 맞추지 않습니다).');
    const arts = new Array(pictures.length);
    let loaded = 0;
    await runLimited(pictures.map((picture, index) => async () => {
      arts[index] = pixelOf(picture) ? await pixelArtOf(picture) : canvasOfImage(await pictureImage(picture));
      toast(`${verb}… 그림 불러오기 ${++loaded}/${pictures.length}`);
    }), 6);
    // 다 불러오면 진행 표시를 곧 지운다(예전엔 창이 뜬 뒤에도 "3/3"이 왼쪽 아래에 남았다).
    toast(`${verb}… 그림 ${pictures.length}개 불러옴`, 800);
    const items = arts.map(trimmedItem);
    const anchors = items.map((item, i) =>
      [Math.round(arts[i].width / 2 - item.rect.x), Math.round(arts[i].height / 2 - item.rect.y)]);
    return { pictures, arts, items, anchors, skippedVector: object.pictures.length - pictures.length };
  }
  // 기준점대로 모든 모양을 같은 크기 틀에 그려 indexes의 모양만 다시 올린다(PNG 10장씩, 픽셀 아트면 아틀라스도).
  // 틀 크기가 지금 모양 크기와 다른 모양은 indexes에 없어도 함께 올린다(모두 같은 크기를 쓰므로).
  // 한 번에 바꿔 끼우고 되돌리기 한 단계로 남긴다. 그 사이 다시 저장했거나 지운 모양은 건너뛴다.
  // beforeUpload(올릴 모양 번호들)가 거짓을 돌려주면 올리지 않고 null을 돌려준다.
  async function commitPictureFrames(object, frames, indexes, verb, beforeUpload) {
    const { pictures, arts, items, anchors } = frames;
    const k = objectPixel(object), scale = k || 1, margin = k ? PIXEL_MARGIN : MARGIN;
    let halfX = 0, halfY = 0;
    items.forEach((item, i) => {
      halfX = Math.max(halfX, anchors[i][0], item.w - anchors[i][0]);
      halfY = Math.max(halfY, anchors[i][1], item.h - anchors[i][1]);
    });
    halfX = Math.ceil(halfX + margin); halfY = Math.ceil(halfY + margin);
    const box = { width: halfX * 2, height: halfY * 2 };
    const size = { width: box.width * scale, height: box.height * scale };
    const send = new Set(indexes);
    pictures.forEach((picture, i) => {
      if (Math.abs(picture.dimension.width - size.width) > .5 || Math.abs(picture.dimension.height - size.height) > .5)
        send.add(i);
    });
    const list = [...send].sort((a, b) => a - b);
    if (!list.length) return { done: 0, skipped: 0 };
    if (beforeUpload && !beforeUpload(list)) return null;
    const frameAt = i => {
      const frame = canvasOfSize(box.width, box.height), context = frame.getContext('2d');
      context.imageSmoothingEnabled = false;
      const { x, y, w, h } = items[i].rect;
      context.drawImage(arts[i], x, y, w, h, halfX - anchors[i][0], halfY - anchors[i][1], w, h);
      context.fillStyle = 'rgba(0, 0, 0, 0.01)';
      for (const [cx, cy] of cornersOf(box)) context.fillRect(cx, cy, 2, 2);
      return frame;
    };
    const uploaded = new Map(), made = new Map();
    const frameOf = i => { if (!made.has(i)) made.set(i, frameAt(i)); return made.get(i); };
    let sent = 0;
    await uploadArts({ indexes: list,
      artAt: i => scale > 1 ? scaledCanvas(frameOf(i), size.width, size.height) : frameOf(i),
      state: {}, onSaved(i, saved) {
        uploaded.set(i, saved);
        toast(`${verb}… 올리기 ${++sent}/${list.length}`);
      } });
    let marks = null;
    if (k) {
      const atlasArts = [];
      for (const i of list) atlasArts[i] = frameOf(i);
      marks = await uploadAtlases(atlasArts, scale, (done, total) => toast(`${verb}… 픽셀 아트 SVG ${done}/${total}`));
    }
    const next = [];
    for (const i of list) {
      const picture = pictures[i], current = object.pictures.find(item => item.id === picture.id);
      if (!current || pictureFile(current) !== pictureFile(picture) || current.fileurl !== picture.fileurl) continue;
      const dimension = { ...current.dimension, width: size.width, height: size.height,
        entryVectorNativeCanvas: true, entryVectorArt: { x: clean(Math.max(anchors[i][0], items[i].w - anchors[i][0])),
          y: clean(Math.max(anchors[i][1], items[i].h - anchors[i][1])) } };
      delete dimension.entryVectorPivot;
      delete dimension.entryVectorAtlas;
      if (marks) dimension.entryVectorAtlas = marks[i];
      const result = { ...current, filename: uploaded.get(i).filename, imageType: 'png', dimension };
      delete result.thumbUrl;
      if (marks) result.fileurl = atlasUrl(marks[i]); else delete result.fileurl;
      next.push(result);
    }
    setPicturesBatch(object.id, next);
    return { done: next.length, skipped: list.length - next.length };
  }
  // 맞출 기준점 규칙(스프라이트 나누기와 같음): 모양마다 그림 부분 상자의 비율 점(pivot)을 같은 자리에 맞추고, 맞춘 전체의
  // 가운데를 회전 중심으로 한다. 돌려주는 anchors[i]는 commitPictureFrames가 틀 가운데에 둘 점(잘라 낸 그림 안 정수 px).
  function pivotAnchors(items, pivot) {
    const points = items.map(item => [Math.round(item.w * pivot.x), Math.round(item.h * pivot.y)]);
    let left = 0, right = 0, top = 0, bottom = 0;
    points.forEach(([x, y], i) => {
      left = Math.max(left, x); right = Math.max(right, items[i].w - x);
      top = Math.max(top, y); bottom = Math.max(bottom, items[i].h - y);
    });
    const dx = Math.round((right - left) / 2), dy = Math.round((bottom - top) / 2);
    return points.map(([x, y]) => [x + dx, y + dy]);
  }
  // 모양 탭 "중심 맞추기": 창에서 맞출 기준점(3×3)을 고르면 오브젝트의 비트맵 모양을 그 규칙으로 맞춰 모두 같은 크기 틀에
  // 다시 올린다. 미리보기는 맞춘 모양 전체를 옅게 겹치고 하나씩 재생한다. 모양 id·이름은 그대로라 블록 코드는 그대로이고,
  // 되돌리기 한 번으로 돌아온다(옛 파일은 서버에 남음). 예전에는 이웃 모양끼리 윤곽이 가장 잘 겹치게 자동으로 옮겼는데,
  // 동작이 섞이면 이어 맞추며 옮긴 양이 쌓여 결국 모두 다시 검사해야 했다(사용자: "거의 쓸모없음").
  let centerDialog = null;
  async function openCenterDialog(c) {
    if (centerDialog) return;
    if (alignBusy || pixelBusy) throw Error('다른 모양 변환이 진행 중입니다.');
    const object = c.object;
    alignBusy = true;
    let frames;
    try { frames = await loadPictureFrames(object, '중심 맞추기 준비 중'); }
    catch (error) { alignBusy = false; throw error; }
    const { pictures, arts, items } = frames, count = pictures.length;
    let pivot = { x: .5, y: .5 }, busy = false, shown = 0;
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    const backdrop = node('div', 'evr-slicer-backdrop'), dialog = node('section', 'evr-slicer evr-center');
    dialog.setAttribute('aria-label', '중심 맞추기');
    const header = node('header', 'evr-slicer-head'), closeButton = node('button', 'evr-slicer-x', '×');
    closeButton.type = 'button'; closeButton.title = '닫기';
    header.append(node('h2', '', `중심 맞추기 · ${object.name}`), closeButton);
    const view = node('div', 'evr-slicer-view'), canvas = node('canvas');
    view.append(canvas);
    const stage = node('div', 'evr-slicer-stage');
    stage.append(view, node('p', 'evr-slicer-hint', '고른 기준점으로 맞춘 모양 전체를 옅게 겹치고, 진하게 하나씩 재생합니다. 십자가 회전 중심입니다.'));
    const side = node('div', 'evr-slicer-side');
    const section = title => { const box = node('div', 'evr-slicer-section'); box.append(node('h3', '', title)); side.append(box); return box; };
    const pivotGrid = node('div', 'evr-slicer-pivot');
    for (const [label, x, y] of PIVOTS) {
      const choice = node('button'); choice.type = 'button'; choice.title = label;
      choice.setAttribute('aria-label', label);
      choice.setAttribute('aria-pressed', String(x === pivot.x && y === pivot.y));
      choice.addEventListener('click', () => {
        pivot = { x, y };
        pivotGrid.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === choice)));
        draw();
      });
      pivotGrid.append(choice);
    }
    section('맞출 기준점').append(pivotGrid, node('p', 'evr-slicer-note',
      '모든 모양의 이 점(그림 부분을 감싼 상자 기준)을 같은 자리에 맞추고, 맞춘 모양 전체를 가운데(회전 중심)에 둡니다. ' +
      '걷는 캐릭터는 아래를 고르면 발 높이가 맞습니다.'));
    section('모양').append(node('p', 'evr-slicer-note', `비트맵 모양 ${count}개를 같은 크기로 다시 올립니다` +
      (frames.skippedVector ? ` · 벡터 모양 ${frames.skippedVector}개는 그대로` : '') + '. 이름·순서는 그대로이고 되돌리기(Ctrl+Z)로 돌아옵니다.'));
    const footer = node('footer', 'evr-slicer-foot'), status = node('span', 'evr-slicer-status', '');
    const cancel = node('button', 'evr-slicer-cancel', '닫기'); cancel.type = 'button';
    const apply = node('button', 'evr-slicer-create', '적용'); apply.type = 'button';
    footer.append(status, cancel, apply);
    const body = node('div', 'evr-slicer-body'); body.append(stage, side);
    dialog.append(header, body, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);
    function draw() {
      const width = view.clientWidth, height = view.clientHeight;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, width, height);
      const anchors = pivotAnchors(items, pivot);
      let halfX = 1, halfY = 1;
      items.forEach((item, i) => {
        halfX = Math.max(halfX, anchors[i][0], item.w - anchors[i][0]);
        halfY = Math.max(halfY, anchors[i][1], item.h - anchors[i][1]);
      });
      const fit = Math.min((width - 40) / (halfX * 2), (height - 40) / (halfY * 2));
      const scale = fit >= 1 ? Math.floor(fit) : fit, cx = Math.round(width / 2), cy = Math.round(height / 2);
      context.imageSmoothingEnabled = false;
      const paint = (i, alpha) => {
        const { x, y, w, h } = items[i].rect;
        context.globalAlpha = alpha;
        context.drawImage(arts[i], x, y, w, h, cx - anchors[i][0] * scale, cy - anchors[i][1] * scale, w * scale, h * scale);
      };
      for (let i = 0; i < count; i++) paint(i, Math.max(.06, .6 / count));
      paint(shown, 1);
      context.globalAlpha = 1;
      context.strokeStyle = '#e05a00'; context.lineWidth = 1;
      context.beginPath();
      context.moveTo(cx - 8, cy + .5); context.lineTo(cx + 9, cy + .5);
      context.moveTo(cx + .5, cy - 8); context.lineTo(cx + .5, cy + 9);
      context.stroke();
      if (!busy) status.textContent = `${shown + 1}/${count} · ${pictures[shown].name}`;
    }
    const timer = setInterval(() => { if (!busy) { shown = (shown + 1) % count; draw(); } }, 125);
    const resizeWatch = new ResizeObserver(() => draw());
    resizeWatch.observe(view);
    // 키는 창에서 먼저 받아 뒤의 엔트리 편집기로 가지 않게 한다(예: Delete가 편집기 그림을 지우지 않게).
    function onKey(event) {
      if (!(event.target instanceof Node) || (!dialog.contains(event.target) && event.target !== document.body)) return;
      if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); close(); }
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    function close(force) {
      if (busy && !force) return;
      clearInterval(timer);
      resizeWatch.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      backdrop.remove();
      centerDialog = null;
      alignBusy = false;
      drawPivotUI();
    }
    closeButton.addEventListener('click', () => close());
    cancel.addEventListener('click', () => close());
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); });
    apply.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      apply.disabled = cancel.disabled = true;
      status.textContent = '적용하는 중…';
      try {
        frames.anchors = pivotAnchors(items, pivot);
        const result = await commitPictureFrames(object, frames, pictures.map((picture, i) => i), '중심 맞추는 중');
        toast(`모양 ${result.done}개의 중심을 맞췄습니다${result.skipped ? ` (그 사이 바뀐 모양 ${result.skipped}개는 그대로)` : ''}` +
          ' · 되돌리기 가능 · 작품을 저장하세요', 6000);
        close(true);
      } catch (error) {
        status.textContent = `적용 실패: ${error.message} · 다시 누르면 다시 올립니다.`;
        busy = false;
        apply.disabled = cancel.disabled = false;
      }
    });
    centerDialog = { close };
    draw();
    apply.focus({ preventScroll: true });
    return centerDialog;
  }
  const PIVOTS = [['왼쪽 위', 0, 0], ['위', .5, 0], ['오른쪽 위', 1, 0],
    ['왼쪽', 0, .5], ['가운데', .5, .5], ['오른쪽', 1, .5],
    ['왼쪽 아래', 0, 1], ['아래', .5, 1], ['오른쪽 아래', 1, 1]];
  // 미리보기 배율 단계(휠·버튼). 정수배일 때 픽셀이 고르게 보인다.
  // 스프라이트 나누기 미리보기와 모양 편집기가 같이 쓴다.
  const ZOOM_STEPS = [.05, .1, .15, .25, .33, .5, .75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
  const clampTo = (value, low, high) => Math.max(low, Math.min(high, value));
  // 지금 배율에서 위(+1)·아래(−1) 단계. 단계 사이에 있으면 그 방향의 가장 가까운 단계로 간다.
  function stepZoomFrom(zoom, direction, min = ZOOM_STEPS[0], max = ZOOM_STEPS[ZOOM_STEPS.length - 1]) {
    const steps = ZOOM_STEPS.filter(step => step >= min - 1e-9 && step <= max + 1e-9);
    return direction > 0 ? steps.find(step => step > zoom * 1.001) ?? zoom :
      steps.slice().reverse().find(step => step < zoom / 1.001) ?? zoom;
  }
  // 휠 한 칸(약 100)마다 배율 한 단계. 터치패드처럼 잘게 오면 모아서 넘긴다. 단계 방향(+1·−1) 또는 0.
  function wheelStepper() {
    let sum = 0;
    return event => {
      sum += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      if (Math.abs(sum) < 50) return 0;
      const direction = sum < 0 ? 1 : -1;
      sum = 0;
      return direction;
    };
  }
  const HANDLES = [[0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]];
  const HANDLE_REACH = 6; // 크기 손잡이를 잡는 거리(화면 px)
  // 스프라이트 나누기 화면. mode 'picture': 모양 탭에서 띄우는 창, 지금 오브젝트에 모양으로 넣는다.
  // mode 'object': 오브젝트 추가하기 창의 탭 안에 넣고, 조각들로 새 오브젝트를 만든다.
  function slicerUI({ mode, c, onClose }) {
    const forObject = mode === 'object', object = c?.object;
    // view: 시트 (0,0)이 놓인 미리보기 위치(x, y)와 배율. autoFit이면 칸 크기가 바뀌어도 전체가 보이게 맞춘다.
    // rects: 만들 영역(위→아래·왼쪽→오른쪽 순서), selected: 고른 영역, past/future: 영역 되돌리기 기록.
    const state = { sheet: null, sheetId: 0, pixels: null, name: forObject ? '' : c.picture.name, mode: 'auto',
      minSize: 4, gap: 0, cellWidth: 32, cellHeight: 32, columns: 4, rows: 1, offsetX: 0, offsetY: 0,
      padX: 0, padY: 0, keepEmpty: false, pivot: { x: .5, y: .5 }, rects: [], selected: new Set(),
      past: [], future: [], edited: false, view: { zoom: 1, x: 0, y: 0 }, autoFit: true, drag: null,
      space: false, busy: false, pixel: false, job: null, closed: false };
    const node = (tag, className, textValue) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (textValue !== undefined) element.textContent = textValue;
      return element;
    };
    const dialog = node('section', forObject ? 'evr-slicer evr-slicer-embed' : 'evr-slicer');
    dialog.setAttribute('aria-label', '스프라이트 나누기');
    const header = node('header', 'evr-slicer-head');
    const closeButton = node('button', 'evr-slicer-x', '×');
    closeButton.type = 'button'; closeButton.title = '닫기';
    header.append(node('h2', '', '스프라이트 나누기'), closeButton);
    const view = node('div', 'evr-slicer-view');
    view.tabIndex = 0; view.setAttribute('aria-label', '시트 미리보기');
    const canvas = node('canvas');
    view.append(canvas);
    const toolbar = node('div', 'evr-slicer-tools');
    const toolButton = (label, title, action) => {
      const button = node('button', 'evr-slicer-tool', label);
      button.type = 'button'; button.title = title;
      button.addEventListener('click', () => { action(); view.focus({ preventScroll: true }); });
      return button;
    };
    const toolGroup = (...buttons) => { const group = node('div', 'evr-slicer-group'); group.append(...buttons); return group; };
    const zoomOut = toolButton('−', '축소', () => zoomCenter(stepZoom(-1)));
    const zoomLabel = toolButton('100%', '실제 크기(100%)로 보기', () => zoomCenter(1));
    const zoomIn = toolButton('+', '확대', () => zoomCenter(stepZoom(1)));
    const fitButton = toolButton('맞춤', '그림 전체가 보이게', () => { state.autoFit = true; draw(); });
    const undoButton = toolButton('되돌리기', '영역 고친 것 되돌리기 (Ctrl+Z)', undo);
    const redoButton = toolButton('다시 실행', '되돌린 것 다시 하기 (Ctrl+Y)', redo);
    const mergeButton = toolButton('합치기', '고른 영역들을 하나로 합칩니다', mergeSelected);
    const splitButton = toolButton('다시 나누기', '고른 영역 안에서 스프라이트를 다시 찾아 나눕니다', splitSelected);
    const trimButton = toolButton('여백 자르기', '고른 영역을 그림이 있는 부분에 딱 맞춥니다', trimSelected);
    const deleteButton = toolButton('지우기', '고른 영역을 지웁니다 (Delete)', deleteSelected);
    toolbar.append(toolGroup(zoomOut, zoomLabel, zoomIn, fitButton), toolGroup(undoButton, redoButton),
      toolGroup(mergeButton, splitButton, trimButton, deleteButton));
    const hint = node('p', 'evr-slicer-hint', '빈 곳 끌기: 영역 추가 · 영역 끌기: 옮기기 · 모서리 끌기: 크기 · ' +
      'Shift+클릭: 여러 개 고르기 · 휠: 확대·축소 · 스페이스·가운데·오른쪽 버튼+끌기: 화면 이동 · Delete: 지우기');
    const stage = node('div', 'evr-slicer-stage');
    stage.append(toolbar, view, hint);
    const side = node('div', 'evr-slicer-side');
    const footer = node('footer', 'evr-slicer-foot');
    const status = node('span', 'evr-slicer-status', '');
    const cancel = node('button', 'evr-slicer-cancel', '취소'); cancel.type = 'button';
    const create = node('button', 'evr-slicer-create', '만들기'); create.type = 'button';
    footer.append(status, ...(forObject ? [] : [cancel]), create);
    const body = node('div', 'evr-slicer-body');
    body.append(stage, side);
    if (!forObject) dialog.append(header);
    dialog.append(body, footer);

    const field = (label, input) => {
      const row = node('label', 'evr-slicer-field');
      row.append(node('span', '', label), input);
      return row;
    };
    const numberInput = (key, min = 0) => {
      const input = node('input'); input.type = 'number'; input.min = String(min);
      input.value = String(state[key]);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        if (Number.isFinite(value) && value >= min) { state[key] = Math.floor(value); schedule(); }
      });
      return input;
    };
    const section = title => { const box = node('div', 'evr-slicer-section'); box.append(node('h3', '', title)); side.append(box); return box; };

    const source = section('그림');
    const fromCostume = node('button', '', '지금 모양'); fromCostume.type = 'button';
    const fromFile = node('button', '', '파일 열기…'); fromFile.type = 'button';
    const fileInput = node('input'); fileInput.type = 'file';
    fileInput.accept = 'image/png,image/gif,image/webp,image/bmp'; fileInput.hidden = true;
    const sourceInfo = node('p', 'evr-slicer-note', '그림 파일을 미리보기 자리에 끌어 놓아도 됩니다.');
    const sourceRow = node('div', 'evr-slicer-row');
    sourceRow.append(...(forObject ? [] : [fromCostume]), fromFile, fileInput);
    source.append(sourceRow, sourceInfo);

    const slicing = section('자르기 방식');
    const modeSelect = node('select');
    for (const [value, label] of [['auto', '자동 (투명 배경)'], ['size', '칸 크기'], ['count', '칸 개수']]) {
      const option = node('option', '', label); option.value = value; modeSelect.append(option);
    }
    modeSelect.addEventListener('change', () => {
      state.mode = modeSelect.value;
      showOptions(); schedule();
    });
    slicing.append(field('방식', modeSelect));
    const autoBox = node('div'); autoBox.append(field('최소 크기(px)', numberInput('minSize', 1)),
      field('합칠 거리(px)', numberInput('gap', 0)),
      node('p', 'evr-slicer-note', '이어진 불투명 픽셀 묶음마다 자릅니다. 떨어진 부분(무기·이펙트)이 따로 잘리면 합칠 거리를 늘리세요.'));
    const sizeBox = node('div'); sizeBox.append(field('칸 너비(px)', numberInput('cellWidth', 1)),
      field('칸 높이(px)', numberInput('cellHeight', 1)));
    const countBox = node('div'); countBox.append(field('열(가로 칸 수)', numberInput('columns', 1)),
      field('행(세로 칸 수)', numberInput('rows', 1)));
    const gridBox = node('div');
    const keepEmpty = node('input'); keepEmpty.type = 'checkbox';
    keepEmpty.addEventListener('change', () => { state.keepEmpty = keepEmpty.checked; schedule(); });
    gridBox.append(field('시작 X', numberInput('offsetX')), field('시작 Y', numberInput('offsetY')),
      field('칸 사이 X', numberInput('padX')), field('칸 사이 Y', numberInput('padY')),
      field('빈 칸도 만들기', keepEmpty));
    const reslice = node('button', '', '다시 자르기'); reslice.type = 'button';
    reslice.title = '직접 고친 영역을 버리고 지금 설정대로 다시 자릅니다';
    reslice.addEventListener('click', () => slice());
    const resliceRow = node('div', 'evr-slicer-row'); resliceRow.append(reslice);
    slicing.append(autoBox, sizeBox, countBox, gridBox, resliceRow, node('p', 'evr-slicer-note',
      '잘못 잘린 곳은 미리보기에서 영역을 골라 합치기·다시 나누기를 하거나 직접 그리세요. ' +
      '설정을 바꾸면 다시 자릅니다(직접 고친 것은 되돌리기로 돌아옵니다).'));
    function showOptions() {
      autoBox.hidden = state.mode !== 'auto';
      sizeBox.hidden = state.mode !== 'size';
      countBox.hidden = state.mode !== 'count';
      gridBox.hidden = state.mode === 'auto';
    }
    showOptions();

    const pivotBox = section('맞출 기준점');
    const pivotGrid = node('div', 'evr-slicer-pivot');
    for (const [label, x, y] of PIVOTS) {
      const choice = node('button'); choice.type = 'button'; choice.title = label;
      choice.setAttribute('aria-label', label);
      choice.setAttribute('aria-pressed', String(x === state.pivot.x && y === state.pivot.y));
      choice.addEventListener('click', () => {
        state.pivot = { x, y };
        pivotGrid.querySelectorAll('button').forEach(item =>
          item.setAttribute('aria-pressed', String(item === choice)));
      });
      pivotGrid.append(choice);
    }
    pivotBox.append(pivotGrid, node('p', 'evr-slicer-note',
      '모든 조각의 이 점(잘라 낸 상자 기준)을 같은 자리에 맞추고, 맞춘 조각 전체를 모양 가운데에 둡니다. ' +
      '걷는 캐릭터는 아래를 고르면 발 높이가 맞습니다.'));

    const naming = section(forObject ? '오브젝트' : '이름');
    const nameInput = node('input'); nameInput.type = 'text'; nameInput.value = state.name;
    nameInput.placeholder = forObject ? '파일 이름' : '';
    nameInput.addEventListener('input', () => { state.name = nameInput.value; });
    naming.append(field(forObject ? '이름' : '앞부분', nameInput));
    if (forObject) {
      const pixelBox = node('input'); pixelBox.type = 'checkbox';
      pixelBox.addEventListener('change', () => { state.pixel = pixelBox.checked; });
      naming.append(field('픽셀 아트 (보간 없음)', pixelBox), node('p', 'evr-slicer-note',
        '모양 이름은 "이름_1, 이름_2…"가 됩니다. 픽셀 아트는 조각들을 SVG 한 장으로 묶어 확장을 꺼도 각지게 보이게 합니다.'));
    } else if (objectPixel(object)) {
      naming.append(node('p', 'evr-slicer-note', objectPixel(object) > 1 ?
        `픽셀 아트 오브젝트라 ${objectPixel(object)}배로 저장합니다.` :
        '픽셀 아트 오브젝트라 조각들을 SVG 한 장으로 묶어 보간 없이 보이게 합니다.'));
    }

    // ---- 미리보기: 화면 이동·확대, 영역 고르기·옮기기·크기 바꾸기·새로 그리기 ----
    // 캔버스는 미리보기 칸 크기만 쓰고 보이는 부분만 그린다(크게 확대해도 캔버스는 커지지 않는다).
    const clamp = clampTo;
    const clampZoom = zoom => clamp(zoom, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    const origin = () => ({ x: Math.round(state.view.x), y: Math.round(state.view.y) });
    const pixelsOf = () => state.pixels ||= sheetPixels(state.sheet);
    function pointOf(event) {
      const box = view.getBoundingClientRect(), sx = event.clientX - box.left, sy = event.clientY - box.top;
      const { x, y } = origin();
      return { sx, sy, x: (sx - x) / state.view.zoom, y: (sy - y) / state.view.zoom };
    }
    function fitView() {
      const sheet = state.sheet, width = view.clientWidth, height = view.clientHeight;
      if (!sheet || !width || !height) return;
      const fit = Math.min((width - 24) / sheet.width, (height - 24) / sheet.height);
      const zoom = clampZoom(fit >= 1 ? Math.floor(fit) : fit);
      state.view = { zoom, x: (width - sheet.width * zoom) / 2, y: (height - sheet.height * zoom) / 2 };
    }
    // 화면 위치 (sx, sy) 아래 그림 점이 그 자리에 머물게 배율을 바꾼다.
    function zoomAt(zoom, sx, sy) {
      const old = state.view, next = clampZoom(zoom);
      state.view = { zoom: next, x: sx - (sx - old.x) * next / old.zoom, y: sy - (sy - old.y) * next / old.zoom };
      state.autoFit = false;
      draw();
    }
    const zoomCenter = zoom => zoomAt(zoom, view.clientWidth / 2, view.clientHeight / 2);
    const stepZoom = direction => stepZoomFrom(state.view.zoom, direction);
    function draw() {
      const count = state.rects.length, picked = state.selected.size, sheet = state.sheet;
      create.textContent = forObject ? `조각 ${count}개로 오브젝트 만들기` : `모양 ${count}개 만들기`;
      create.disabled = state.busy || !count;
      mergeButton.disabled = state.busy || picked < 2;
      for (const button of [splitButton, trimButton, deleteButton]) button.disabled = state.busy || !picked;
      undoButton.disabled = state.busy || !state.past.length;
      redoButton.disabled = state.busy || !state.future.length;
      for (const button of [zoomOut, zoomLabel, zoomIn, fitButton]) button.disabled = !sheet;
      const width = view.clientWidth, height = view.clientHeight, ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth; canvas.height = pixelHeight;
      }
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      if (!sheet || !width || !height) return;
      if (state.autoFit) fitView();
      const { zoom } = state.view, o = origin();
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      // 보이는 부분만 그린다. 줄여 볼 때만 부드럽게 줄인다.
      const left = clamp(Math.floor(-o.x / zoom), 0, sheet.width), top = clamp(Math.floor(-o.y / zoom), 0, sheet.height);
      const right = clamp(Math.ceil((width - o.x) / zoom), 0, sheet.width);
      const bottom = clamp(Math.ceil((height - o.y) / zoom), 0, sheet.height);
      g.imageSmoothingEnabled = zoom < 1;
      if (right > left && bottom > top) g.drawImage(sheet, left, top, right - left, bottom - top,
        o.x + left * zoom, o.y + top * zoom, (right - left) * zoom, (bottom - top) * zoom);
      g.lineWidth = 1;
      if (zoom >= 12 && right > left && bottom > top) { // 크게 보면 픽셀 칸을 그린다
        g.beginPath();
        for (let x = left; x <= right; x++) {
          g.moveTo(o.x + x * zoom + .5, o.y + top * zoom); g.lineTo(o.x + x * zoom + .5, o.y + bottom * zoom);
        }
        for (let y = top; y <= bottom; y++) {
          g.moveTo(o.x + left * zoom, o.y + y * zoom + .5); g.lineTo(o.x + right * zoom, o.y + y * zoom + .5);
        }
        g.strokeStyle = 'rgba(44, 58, 75, .12)'; g.stroke();
      }
      g.strokeStyle = 'rgba(44, 58, 75, .45)';
      g.strokeRect(o.x - .5, o.y - .5, sheet.width * zoom + 1, sheet.height * zoom + 1);
      g.font = '600 11px sans-serif'; g.textBaseline = 'top';
      const screen = rect => ({ x: o.x + rect.x * zoom, y: o.y + rect.y * zoom, w: rect.w * zoom, h: rect.h * zoom });
      state.rects.forEach((rect, index) => {
        const box = screen(rect), on = state.selected.has(rect), color = on ? '#4f80ff' : '#13c27a';
        if (box.x > width || box.y > height || box.x + box.w < 0 || box.y + box.h < 0) return;
        if (on) { g.fillStyle = 'rgba(79, 128, 255, .18)'; g.fillRect(box.x, box.y, box.w, box.h); }
        g.lineWidth = on ? 2 : 1; g.strokeStyle = color;
        g.strokeRect(box.x + .5, box.y + .5, Math.max(1, box.w - 1), Math.max(1, box.h - 1));
        if (box.w < 14 || box.h < 10) return; // 너무 작게 보이면 번호는 뺀다
        const label = String(index + 1);
        g.fillStyle = color; g.fillRect(box.x, box.y, g.measureText(label).width + 6, 14);
        g.fillStyle = '#fff'; g.fillText(label, box.x + 3, box.y + 2);
      });
      g.lineWidth = 1;
      const one = resizable();
      if (one) {
        const box = screen(one);
        for (const [hx, hy] of HANDLES) {
          const x = Math.round(box.x + box.w * hx), y = Math.round(box.y + box.h * hy);
          g.fillStyle = '#fff'; g.fillRect(x - 3, y - 3, 7, 7);
          g.strokeStyle = '#4f80ff'; g.strokeRect(x - 3.5, y - 3.5, 8, 8);
        }
      }
      const drawing = state.drag?.kind === 'create' && state.drag.rect;
      if (drawing) {
        const box = screen(drawing);
        g.setLineDash([4, 3]); g.strokeStyle = '#4f80ff';
        g.strokeRect(box.x + .5, box.y + .5, Math.max(1, box.w - 1), Math.max(1, box.h - 1));
        g.setLineDash([]);
      }
    }
    function showStatus() {
      const count = state.rects.length, picked = state.selected.size;
      status.textContent = !state.sheet ? '' : picked ? `영역 ${picked}개를 골랐습니다.` :
        !count ? '자를 조각이 없습니다. 빈 곳을 끌어 영역을 직접 만들 수 있습니다.' :
        state.mode === 'auto' && count > 100 && !state.edited ?
          `조각이 ${count}개입니다. 한 그림이 여러 조각으로 쪼개졌다면 합칠 거리나 ` +
          '최소 크기를 늘리거나 칸 크기 방식을 쓰세요.' :
        '잘못 잘린 곳은 영역을 골라 합치기·다시 나누기로 고치세요.';
    }
    // 크기 손잡이는 영역 하나만 골랐고 화면에서 충분히 클 때만 보인다(작으면 옮기기를 막지 않게).
    function resizable() {
      if (state.selected.size !== 1 || state.busy) return null;
      const [rect] = state.selected;
      return rect.w * state.view.zoom >= 16 && rect.h * state.view.zoom >= 16 ? rect : null;
    }
    function handleAt(point) {
      const rect = resizable();
      if (!rect) return null;
      const { zoom } = state.view, o = origin();
      for (const [hx, hy] of HANDLES) {
        if (Math.abs(point.sx - (o.x + (rect.x + rect.w * hx) * zoom)) <= HANDLE_REACH &&
          Math.abs(point.sy - (o.y + (rect.y + rect.h * hy) * zoom)) <= HANDLE_REACH) return { rect, hx, hy };
      }
      return null;
    }
    // 겹친 영역이면 고른 것, 그다음 작은 것을 잡는다(큰 영역 안의 작은 영역도 고를 수 있게).
    function rectAt(point) {
      let found = null, best = Infinity;
      for (const rect of state.rects) {
        if (point.x < rect.x || point.y < rect.y || point.x >= rect.x + rect.w || point.y >= rect.y + rect.h) continue;
        const rank = rect.w * rect.h - (state.selected.has(rect) ? 1e9 : 0);
        if (rank < best) { found = rect; best = rank; }
      }
      return found;
    }
    function cursorAt(point) {
      if (state.drag?.kind === 'pan') return 'grabbing';
      if (state.space) return 'grab';
      if (!state.sheet || state.busy) return '';
      const handle = handleAt(point);
      if (handle) return handle.hx === .5 ? 'ns-resize' : handle.hy === .5 ? 'ew-resize' :
        handle.hx === handle.hy ? 'nwse-resize' : 'nesw-resize';
      return rectAt(point) ? 'move' : 'crosshair';
    }
    // 영역 되돌리기: 바꾸기 직전 영역 목록을 통째로 남긴다(최대 100단계).
    const snapshot = () => state.rects.map(rect => ({ ...rect }));
    function remember() {
      state.past.push(snapshot());
      if (state.past.length > 100) state.past.shift();
      state.future = [];
    }
    function travel(from, to) {
      if (state.busy || state.drag || !from.length) return;
      to.push(snapshot());
      state.rects = from.pop(); state.selected.clear(); state.edited = true;
      showStatus(); draw();
    }
    function undo() { travel(state.past, state.future); }
    function redo() { travel(state.future, state.past); }
    function changed() {
      state.edited = true;
      state.rects = readingOrder(state.rects);
      showStatus(); draw();
    }
    // 고른 영역들을 (dx, dy)만큼 옮긴다(그림 밖으로는 나가지 않게). starts: [영역, 처음 x, 처음 y]
    function moveFrom(starts, dx, dy) {
      const { width, height } = state.sheet;
      for (const [rect, x, y] of starts) {
        dx = clamp(dx, -x, width - rect.w - x); dy = clamp(dy, -y, height - rect.h - y);
      }
      for (const [rect, x, y] of starts) { rect.x = x + dx; rect.y = y + dy; }
    }
    function deleteSelected() {
      if (state.busy || !state.selected.size) return;
      remember();
      state.rects = state.rects.filter(rect => !state.selected.has(rect));
      state.selected.clear();
      changed();
    }
    function mergeSelected() {
      if (state.busy || state.selected.size < 2) return;
      const list = [...state.selected], x = Math.min(...list.map(rect => rect.x)), y = Math.min(...list.map(rect => rect.y));
      const merged = { x, y, w: Math.max(...list.map(rect => rect.x + rect.w)) - x,
        h: Math.max(...list.map(rect => rect.y + rect.h)) - y };
      remember();
      state.rects = state.rects.filter(rect => !state.selected.has(rect)).concat(merged);
      state.selected = new Set([merged]);
      changed();
    }
    // 고른 영역 안에서만 다시 찾는다. 본체끼리는 합치지 않아 붙어 잘린 이웃이 나뉜다.
    function splitSelected() {
      if (state.busy || !state.selected.size) return;
      const pieces = new Map();
      for (const rect of state.selected) {
        const found = detectSprites(pixelsOf(), state.sheet.width, rect,
          { minSize: state.minSize, gap: state.gap, split: true });
        if (found.length > 1) pieces.set(rect, found);
      }
      if (!pieces.size) { status.textContent = '더 나눌 수 없습니다. 영역을 직접 그려 나누세요.'; return; }
      remember();
      state.rects = state.rects.flatMap(rect => pieces.get(rect) || [rect]);
      state.selected = new Set([...pieces.values()].flat());
      changed();
    }
    function trimSelected() {
      if (state.busy || !state.selected.size) return;
      const pixels = pixelsOf(), width = state.sheet.width, trimmed = new Map();
      for (const rect of state.selected) {
        let left = Infinity, top = Infinity, right = -1, bottom = -1;
        for (let y = rect.y; y < rect.y + rect.h; y++) {
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            if (!opaqueAt(pixels, y * width + x)) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            bottom = y;
          }
        }
        const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
        if (right >= 0 && (box.x !== rect.x || box.y !== rect.y || box.w !== rect.w || box.h !== rect.h))
          trimmed.set(rect, box);
      }
      if (!trimmed.size) { status.textContent = '자를 여백이 없습니다.'; return; }
      remember();
      for (const [rect, box] of trimmed) Object.assign(rect, box);
      changed();
    }
    function cancelDrag() {
      const drag = state.drag;
      if (!drag) return;
      state.drag = null;
      if (drag.moved && (drag.kind === 'move' || drag.kind === 'resize')) {
        state.rects = state.past.pop(); state.selected.clear();
      }
      if (view.hasPointerCapture(drag.pointer)) view.releasePointerCapture(drag.pointer);
    }
    let hovering = false;
    view.addEventListener('pointerenter', () => { hovering = true; });
    view.addEventListener('pointerleave', () => { hovering = false; });
    view.addEventListener('contextmenu', event => event.preventDefault());
    view.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); }); // 자동 스크롤 막기
    view.addEventListener('pointerdown', event => {
      if (!state.sheet || state.drag) return;
      view.focus({ preventScroll: true });
      const point = pointOf(event);
      let drag = null;
      if (event.button === 1 || event.button === 2 || (event.button === 0 && state.space)) {
        drag = { kind: 'pan', x: state.view.x, y: state.view.y };
      } else if (event.button === 0 && !state.busy) {
        const handle = handleAt(point), hit = handle ? null : rectAt(point);
        if (handle) drag = { kind: 'resize', ...handle, start: { ...handle.rect } };
        else if (hit && event.shiftKey) {
          if (state.selected.has(hit)) state.selected.delete(hit); else state.selected.add(hit);
        } else if (hit) {
          const was = state.selected.has(hit);
          if (!was) state.selected = new Set([hit]);
          drag = { kind: 'move', hit, was, starts: [...state.selected].map(rect => [rect, rect.x, rect.y]) };
        } else {
          if (!event.shiftKey) state.selected.clear();
          drag = { kind: 'create', rect: null };
        }
        showStatus();
      } else return;
      event.preventDefault();
      if (drag) {
        Object.assign(drag, { point, pointer: event.pointerId, moved: false });
        state.drag = drag;
        view.setPointerCapture(event.pointerId);
      }
      view.style.cursor = cursorAt(point);
      draw();
    });
    view.addEventListener('pointermove', event => {
      const drag = state.drag, point = pointOf(event);
      if (!drag) { view.style.cursor = cursorAt(point); return; }
      if (drag.pointer !== event.pointerId) return;
      if (drag.kind === 'pan') {
        state.view = { ...state.view, x: drag.x + point.sx - drag.point.sx, y: drag.y + point.sy - drag.point.sy };
        state.autoFit = false;
        draw();
        return;
      }
      if (!drag.moved) {
        if (Math.hypot(point.sx - drag.point.sx, point.sy - drag.point.sy) < 3) return;
        drag.moved = true;
        if (drag.kind !== 'create') remember();
      }
      const { width, height } = state.sheet;
      if (drag.kind === 'move') {
        moveFrom(drag.starts, Math.round(point.x - drag.point.x), Math.round(point.y - drag.point.y));
      } else if (drag.kind === 'resize') {
        const start = drag.start, px = Math.round(point.x), py = Math.round(point.y);
        let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
        if (drag.hx === 0) left = clamp(px, 0, right - 1); else if (drag.hx === 1) right = clamp(px, left + 1, width);
        if (drag.hy === 0) top = clamp(py, 0, bottom - 1); else if (drag.hy === 1) bottom = clamp(py, top + 1, height);
        Object.assign(drag.rect, { x: left, y: top, w: right - left, h: bottom - top });
      } else {
        const x0 = clamp(Math.floor(drag.point.x), 0, width - 1), y0 = clamp(Math.floor(drag.point.y), 0, height - 1);
        const x1 = clamp(Math.floor(point.x), 0, width - 1), y1 = clamp(Math.floor(point.y), 0, height - 1);
        drag.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
      }
      draw();
    });
    function endDrag(event) {
      const drag = state.drag;
      if (!drag || drag.pointer !== event.pointerId) return;
      state.drag = null;
      if (drag.kind === 'create' && drag.rect) {
        remember();
        state.rects.push(drag.rect);
        state.selected = new Set([drag.rect]);
        changed();
      } else if (drag.moved && drag.kind !== 'pan') changed();
      else {
        // 여러 개 고른 채 그중 하나를 끌지 않고 누르면 그것만 고른다.
        if (drag.kind === 'move' && drag.was && state.selected.size > 1) state.selected = new Set([drag.hit]);
        showStatus(); draw();
      }
      view.style.cursor = cursorAt(pointOf(event));
    }
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    const wheelStep = wheelStepper();
    view.addEventListener('wheel', event => {
      if (!state.sheet) return;
      event.preventDefault();
      const direction = wheelStep(event);
      if (!direction) return;
      const point = pointOf(event);
      zoomAt(stepZoom(direction), point.sx, point.sy);
    }, { passive: false });
    // 키는 창(window)에서 먼저 받아, 미리보기에서 누른 Delete·Ctrl+Z가 엔트리(뒤의 모양 편집기 등)로
    // 가지 않게 한다. 입력칸에서 누른 키는 건드리지 않는다.
    function onKey(event) {
      if (!(event.target instanceof Node) || !dialog.contains(event.target) ||
        (event.target instanceof Element && event.target.closest('input, select, textarea'))) return;
      const key = event.key, mod = event.ctrlKey || event.metaKey;
      const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : '';
      if (key === ' ') {
        // 미리보기 위에 마우스가 있거나 미리보기에 포커스가 있을 때만(옆 칸 버튼은 스페이스로 누를 수 있게)
        if (event.type === 'keydown' ? !hovering && event.target !== view : !state.space) return;
        state.space = event.type === 'keydown';
        if (!state.drag) view.style.cursor = state.space ? 'grab' : '';
      } else if (event.type !== 'keydown') return;
      else if (key === 'Delete' || key === 'Backspace') deleteSelected();
      else if (mod && (letter === 'z' || letter === 'y')) { if (letter === 'y' || event.shiftKey) redo(); else undo(); }
      else if (mod && letter === 'a') { state.selected = new Set(state.rects); showStatus(); draw(); }
      else if (key.startsWith('Arrow') && state.selected.size && !state.busy && !state.drag) {
        const step = event.shiftKey ? 10 : 1;
        remember();
        moveFrom([...state.selected].map(rect => [rect, rect.x, rect.y]),
          key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
          key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
        changed();
      } else if (key === 'Escape' && (state.selected.size || state.drag)) {
        cancelDrag(); state.selected.clear(); showStatus(); draw();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }
    const releaseSpace = () => { state.space = false; };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', releaseSpace);
    const resizeWatch = new ResizeObserver(() => draw());
    resizeWatch.observe(view);
    let timer = 0;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(slice, 120);
    }
    // 지금 설정대로 다시 자른다. 직접 고친 영역은 되돌리기 기록에 남긴다.
    function slice() {
      if (!state.sheet) return;
      const { width, height } = state.sheet;
      const next = state.mode === 'auto' ? detectSprites(pixelsOf(), width, { x: 0, y: 0, w: width, h: height }, state) :
        gridRects(state.sheet, state);
      const hadEdits = state.edited;
      if (state.rects.length && JSON.stringify(next) !== JSON.stringify(state.rects)) remember();
      state.rects = next; state.selected.clear(); state.edited = false;
      showStatus();
      if (hadEdits) status.textContent = '설정대로 다시 잘랐습니다. 직접 고친 영역은 되돌리기(Ctrl+Z)로 돌아옵니다.';
      draw();
    }
    function useSheet(sheet, name, note) {
      if (sheet.width * sheet.height > 4096 * 4096) {
        status.textContent = '그림이 너무 큽니다(최대 4096×4096px).';
        return;
      }
      cancelDrag();
      Object.assign(state, { sheet, sheetId: state.sheetId + 1, pixels: null, job: null, rects: [],
        selected: new Set(), past: [], future: [], edited: false, autoFit: true });
      if (name) { state.name = name; nameInput.value = name; }
      sourceInfo.textContent = `${note} · ${sheet.width}×${sheet.height}px`;
      if (state.mode !== 'auto') {
        state.cellWidth = Math.min(state.cellWidth, sheet.width);
        state.cellHeight = Math.min(state.cellHeight, sheet.height);
      }
      schedule();
    }
    async function loadCostume() {
      const picture = context()?.picture || c.picture;
      if (picture.imageType === 'svg' && !pixelOf(picture)) {
        status.textContent = '벡터 모양은 파일로 여세요.';
        return;
      }
      const image = await pictureImage(picture), k = pixelOf(picture);
      useSheet(k > 1 ? scaledCanvas(image, Math.round(image.naturalWidth / k),
        Math.round(image.naturalHeight / k)) : canvasOfImage(image), picture.name, `모양 "${picture.name}"`);
    }
    function openFile(file) {
      if (!file || state.busy) return;
      const url = URL.createObjectURL(file);
      loadImage(url).then(image => useSheet(canvasOfImage(image),
        file.name.replace(/\.[^.]+$/, ''), `파일 "${file.name}"`))
        .catch(() => { status.textContent = '그림 파일을 열 수 없습니다.'; })
        .finally(() => URL.revokeObjectURL(url));
    }
    fromCostume.addEventListener('click', () => loadCostume().catch(error => {
      status.textContent = error.message;
    }));
    fromFile.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { openFile(fileInput.files?.[0]); fileInput.value = ''; });
    view.addEventListener('dragover', event => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
    });
    view.addEventListener('drop', event => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      openFile(file);
    });
    // 조각을 올리며 앞쪽부터 올라온 만큼 차례로 넣는다(약 0.3초마다, 되돌리기는 한 단계). 새 오브젝트는 첫
    // 묶음으로 만들고(오브젝트 추가하기 창이 닫힘) 나머지는 이어 붙이며 진행은 화면 왼쪽 아래에 보인다.
    // 실패하면 넣은 조각은 남고, 모양 탭에서는 다시 누르면 남은 조각만 이어서 올린다.
    async function run() {
      if (state.busy) return;
      if (!state.sheet) { status.textContent = '그림 파일을 먼저 여세요.'; return; }
      const rects = state.rects.map(({ x, y, w, h }) => ({ x, y, w, h }));
      if (!rects.length) return;
      // 개수 제한은 두지 않는다. 자동 자르기가 그림을 잘게 쪼갠 경우를 알아챌 수 있게 많을 때만 묻는다.
      if (!state.job && rects.length > 100 && !window.confirm(`조각 ${rects.length}개를 만듭니다. ` +
          '조각마다 서버에 올리므로 시간이 걸립니다. 계속할까요?')) return;
      // 픽셀 아트: 새 오브젝트는 1배(아틀라스), 예전 방식 k배 픽셀 오브젝트에 넣을 때는 그 k배로 맞춘다.
      const pixel = forObject ? (state.pixel ? 1 : 0) : objectPixel(object);
      const key = JSON.stringify([state.sheetId, rects, state.pivot, pixel]);
      state.busy = true; draw();
      if (state.job?.key !== key) {
        state.job = { key, sheet: state.sheet, rects, pivot: state.pivot,
          pixel, results: new Array(rects.length), cancelled: false, inserted: 0, target: null, list: null };
      }
      const job = state.job;
      job.name ||= (state.name || '').trim() || (forObject ? '스프라이트' : '모양');
      let timer = 0;
      const flush = () => {
        clearTimeout(timer); timer = 0;
        if (job.cancelled) return;
        let end = job.inserted;
        while (end < job.results.length && job.results[end]) end++;
        if (end === job.inserted) return;
        const more = job.results.slice(job.inserted, end).map((picture, i) =>
          ({ ...copy(picture), name: `${job.name}_${job.inserted + i + 1}` }));
        if (!job.target && forObject) {
          job.committed = true; // 이제 창을 닫아도 멈추지 않는다
          job.target = addSheetObject(job.name, more);
        } else if (!job.target) {
          job.target = object; job.list = more;
          addPicturesBatch(object.id, more);
        } else if (!appendPictures(job.target, more, job.list)) {
          job.cancelled = true;
          return;
        }
        job.inserted = end;
      };
      const progress = (done, total, phase) => {
        if (phase) { status.textContent = `${phase} 올리는 중…`; return; }
        status.textContent = `올리는 중… ${done}/${total}`;
        if (job.committed) toast(`스프라이트 만드는 중… ${done}/${total}`);
        if (!timer) timer = setTimeout(flush, 300);
      };
      try {
        await uploadFrames(job, progress);
        flush();
        if (job.cancelled) return;
        state.job = null;
        const message = `${job.inserted}개를 만들었습니다.`;
        status.textContent = message;
        if (job.committed) toast(`${message} · 작품을 저장하세요`, 4000);
        state.busy = false;
        api.close();
      } catch (error) {
        flush();
        if (job.cancelled) return;
        const message = `${job.inserted}/${rects.length}개 만들고 멈췄습니다 · ${error.message}`;
        status.textContent = `${message} · 다시 누르면 남은 조각만 올립니다.`;
        if (job.committed) toast(message, 8000);
      } finally {
        clearTimeout(timer);
        state.busy = false;
        draw();
      }
    }
    create.addEventListener('click', run);
    const api = {
      element: dialog, run, busy: () => state.busy,
      close() {
        state.closed = true;
        if (state.job && !state.job.committed) state.job.cancelled = true;
        clearTimeout(timer);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('blur', releaseSpace);
        resizeWatch.disconnect();
        onClose?.();
      },
      loadCostume,
    };
    closeButton.addEventListener('click', () => { if (!state.busy) api.close(); });
    cancel.addEventListener('click', () => { if (!state.busy) api.close(); });
    draw();
    return api;
  }
  // ---- 모양 맞추기 창 ----
  // 여러 모양을 한 화면에서 맞춘다. 아래 모양 띠에서 고르고(누르기, Shift 범위, Ctrl 하나씩 더하기, Ctrl+A 전부), 화면을
  // 끌거나 화살표로 고른 모양을 모두 함께 1픽셀(Shift 10픽셀)씩 옮긴다(픽셀 격자 단위). 기준 모양을 고정해 주황으로,
  // 앞·뒤 모양을 빨강·파랑으로 겹쳐 본다. 재생으로 흔들림을 보고, 적용하면 바뀐 모양만 다시 올린다(되돌리기 한 번).
  // 화면 이동·확대는 스프라이트 나누기와 같다(휠, 스페이스·가운데·오른쪽 버튼 끌기).
  let aligner = null;
  const TINTS = { ref: 'rgb(255, 140, 0)', before: 'rgb(230, 40, 40)', after: 'rgb(40, 110, 255)' };
  async function openAligner(c) {
    if (aligner) return;
    if (alignBusy || pixelBusy) throw Error('다른 모양 변환이 진행 중입니다.');
    const object = c.object;
    alignBusy = true;
    let frames;
    try { frames = await loadPictureFrames(object, '모양 맞추기 준비 중'); }
    catch (error) { alignBusy = false; throw error; }
    toast('모양 맞추기를 열었습니다.', 1500);
    const { pictures, arts, items } = frames, count = pictures.length;
    const start = frames.anchors.map(point => point.slice());
    const current0 = Math.max(0, pictures.findIndex(picture => picture.id === c.picture.id));
    const state = { current: current0, selected: new Set([current0]), last: current0,
      ref: pictures.findIndex(picture => picture.id === pinnedPictures.get(object.id)), before: 1, after: 1,
      view: { zoom: 1, x: 0, y: 0 }, autoFit: true, past: [], future: [], drag: null, space: false,
      playing: 0, fps: 12, busy: false };
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    const backdrop = node('div', 'evr-slicer-backdrop');
    const dialog = node('section', 'evr-slicer evr-aligner');
    dialog.setAttribute('aria-label', '모양 맞추기');
    const header = node('header', 'evr-slicer-head'), closeButton = node('button', 'evr-slicer-x', '×');
    closeButton.type = 'button'; closeButton.title = '닫기';
    header.append(node('h2', '', `모양 맞추기 · ${object.name}`), closeButton);
    const view = node('div', 'evr-slicer-view'), canvas = node('canvas');
    view.tabIndex = 0; view.append(canvas);
    const toolbar = node('div', 'evr-slicer-tools');
    const tool = (label, title, action) => {
      const button = node('button', 'evr-slicer-tool', label);
      button.type = 'button'; button.title = title;
      button.addEventListener('click', () => { action(); view.focus({ preventScroll: true }); });
      return button;
    };
    const group = (...buttons) => { const box = node('div', 'evr-slicer-group'); box.append(...buttons); return box; };
    const zoomOut = tool('−', '축소', () => zoomCenter(stepZoomFrom(state.view.zoom, -1)));
    const zoomLabel = tool('100%', '실제 크기(100%)로 보기', () => zoomCenter(1));
    const zoomIn = tool('+', '확대', () => zoomCenter(stepZoomFrom(state.view.zoom, 1)));
    const fitButton = tool('맞춤', '지금 모양 앞뒤와 기준 모양이 보이게', () => { fitExtent = null; state.autoFit = true; draw(); });
    const undoButton = tool('되돌리기', '되돌리기 (Ctrl+Z)', () => travel(state.past, state.future));
    const redoButton = tool('다시 실행', '다시 실행 (Ctrl+Y)', () => travel(state.future, state.past));
    const playButton = tool('재생', '고른 모양(2개 이상이면) 또는 전체를 차례로 보기', () => togglePlay());
    const autoButton = tool('자동 맞춤', '고른 모양끼리 가장 잘 겹치게 맞춤(첫 모양은 그대로)', () => autoAlign());
    const resetButton = tool('원래대로', '고른 모양을 연 때 위치로', () => resetSelected());
    toolbar.append(group(zoomOut, zoomLabel, zoomIn, fitButton), group(undoButton, redoButton),
      group(playButton), group(autoButton, resetButton));
    const strip = node('div', 'evr-aligner-strip');
    const hint = node('p', 'evr-slicer-hint', '끌기·화살표: 고른 모양 옮기기(1픽셀, Shift 10픽셀) · 띠에서 Shift·Ctrl+누르기: 여러 개 · ' +
      ', . : 앞·뒤 모양 · Ctrl+A: 전부 · 휠: 확대 · 스페이스·가운데·오른쪽 버튼+끌기: 화면 이동');
    const stage = node('div', 'evr-slicer-stage');
    stage.append(toolbar, view, strip, hint);
    const side = node('div', 'evr-slicer-side');
    const section = title => { const box = node('div', 'evr-slicer-section'); box.append(node('h3', '', title)); side.append(box); return box; };
    const field = (label, input) => { const row = node('label', 'evr-slicer-field'); row.append(node('span', '', label), input); return row; };
    const pickInfo = node('p', 'evr-slicer-note');
    const selectAll = node('button', '', '모두 고르기'); selectAll.type = 'button';
    selectAll.addEventListener('click', () => { selectRange(0, count - 1); render(); });
    const selectOne = node('button', '', '지금 모양만'); selectOne.type = 'button';
    selectOne.addEventListener('click', () => { state.selected = new Set([state.current]); render(); });
    const pickRow = node('div', 'evr-slicer-row'); pickRow.append(selectAll, selectOne);
    section('고른 모양').append(pickInfo, pickRow);
    const refInfo = node('p', 'evr-slicer-note');
    const refSet = node('button', '', '지금 모양으로'); refSet.type = 'button';
    refSet.title = '지금 모양을 기준으로 고정(어느 모양을 볼 때나 주황으로 겹쳐 보임)';
    refSet.addEventListener('click', () => { state.ref = state.current; pinnedPictures.set(object.id, pictures[state.ref].id); render(); });
    const refClear = node('button', '', '해제'); refClear.type = 'button';
    refClear.addEventListener('click', () => { state.ref = -1; pinnedPictures.delete(object.id); render(); });
    const refRow = node('div', 'evr-slicer-row'); refRow.append(refSet, refClear);
    section('기준 모양 (주황)').append(refInfo, refRow);
    const numberInput = (key, min, max) => {
      const input = node('input'); input.type = 'number'; input.min = String(min); input.max = String(max);
      input.value = String(state[key]);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        if (Number.isFinite(value) && value >= min && value <= max) { state[key] = Math.floor(value); if (key === 'fps' && state.playing) { togglePlay(); togglePlay(); } draw(); }
      });
      return input;
    };
    section('어니언').append(field('앞 모양 (빨강)', numberInput('before', 0, 5)), field('뒤 모양 (파랑)', numberInput('after', 0, 5)));
    section('재생').append(field('초당 장면', numberInput('fps', 1, 60)));
    const footer = node('footer', 'evr-slicer-foot'), status = node('span', 'evr-slicer-status', '');
    const cancel = node('button', 'evr-slicer-cancel', '닫기'); cancel.type = 'button';
    const apply = node('button', 'evr-slicer-create', '적용'); apply.type = 'button';
    footer.append(status, cancel, apply);
    const body = node('div', 'evr-slicer-body'); body.append(stage, side);
    dialog.append(header, body, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);

    // 띠: 모양마다 작은 그림과 번호
    const thumbs = pictures.map((picture, i) => {
      const button = node('button', 'evr-aligner-frame'); button.type = 'button';
      button.title = `${i + 1}. ${picture.name}`;
      const thumb = node('canvas'); thumb.width = thumb.height = 48;
      const { x, y, w, h } = items[i].rect, fit = Math.min(48 / w, 48 / h, 4), g = thumb.getContext('2d');
      g.imageSmoothingEnabled = fit < 1;
      g.drawImage(arts[i], x, y, w, h, (48 - w * fit) / 2, (48 - h * fit) / 2, w * fit, h * fit);
      button.append(thumb, node('span', '', String(i + 1)));
      button.addEventListener('click', event => {
        stopPlay();
        if (event.shiftKey) selectRange(state.last, i);
        else if (event.ctrlKey || event.metaKey) {
          if (state.selected.has(i) && state.selected.size > 1) state.selected.delete(i); else state.selected.add(i);
        } else state.selected = new Set([i]);
        state.current = i;
        if (!event.shiftKey) state.last = i;
        if (!state.selected.has(i)) state.current = [...state.selected][0];
        render();
        view.focus({ preventScroll: true });
      });
      strip.append(button);
      return button;
    });
    function selectRange(a, b) {
      state.selected = new Set();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(i);
    }
    const moved = i => state.anchorsChanged?.has(i);
    const changedList = () => frames.anchors.map((a, i) => i).filter(i =>
      frames.anchors[i][0] !== start[i][0] || frames.anchors[i][1] !== start[i][1]);

    // 그리기: 회전 중심(십자)이 화면 원점. 모양 i는 잘라 낸 그림을 (-기준점)에 그린다.
    const tinted = new Map();
    function tintOf(i, color) {
      const key = `${i}:${color}`;
      if (tinted.has(key)) return tinted.get(key);
      const { x, y, w, h } = items[i].rect, out = canvasOfSize(w, h), g = out.getContext('2d');
      g.drawImage(arts[i], x, y, w, h, 0, 0, w, h);
      g.globalCompositeOperation = 'source-atop'; g.globalAlpha = .65; g.fillStyle = color; g.fillRect(0, 0, w, h);
      tinted.set(key, out);
      return out;
    }
    // 맞춤: 지금 모양 앞뒤 5개와 기준 모양이 들어가게(전체 모양에 맞추면 큰 그림 하나 때문에 너무 작아진다).
    function extent() {
      let x = 1, y = 1;
      const near = [state.ref];
      for (let i = state.current - 5; i <= state.current + 5; i++) near.push(i);
      for (const i of near) {
        if (i < 0 || i >= count) continue;
        const [ax, ay] = frames.anchors[i];
        x = Math.max(x, ax, items[i].w - ax);
        y = Math.max(y, ay, items[i].h - ay);
      }
      return { x, y };
    }
    function fitView() {
      const width = view.clientWidth, height = view.clientHeight;
      if (!width || !height) return;
      const extent = fitExtent ||= extentNow();
      const fit = Math.min((width - 40) / (extent.x * 2), (height - 40) / (extent.y * 2));
      const zoom = clampTo(fit >= 1 ? Math.floor(fit) : fit, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
      state.view = { zoom, x: width / 2, y: height / 2 };
    }
    // 맞춘 범위는 "맞춤"을 누르거나 창을 열 때만 다시 잰다(모양을 넘길 때마다 배율이 바뀌지 않게).
    let fitExtent = null;
    const extentNow = extent;
    function zoomAt(zoom, sx, sy) {
      const old = state.view, next = clampTo(zoom, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
      state.view = { zoom: next, x: sx - (sx - old.x) * next / old.zoom, y: sy - (sy - old.y) * next / old.zoom };
      state.autoFit = false;
      draw();
    }
    const zoomCenter = zoom => zoomAt(zoom, view.clientWidth / 2, view.clientHeight / 2);
    function draw() {
      const width = view.clientWidth, height = view.clientHeight, ratio = window.devicePixelRatio || 1;
      const pw = Math.round(width * ratio), ph = Math.round(height * ratio);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, pw, ph);
      if (!width || !height) return;
      if (state.autoFit) fitView();
      const { zoom } = state.view, ox = Math.round(state.view.x), oy = Math.round(state.view.y);
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.imageSmoothingEnabled = zoom < 1;
      const put = (i, source, alpha) => {
        const { x, y, w, h } = items[i].rect, [ax, ay] = frames.anchors[i];
        g.globalAlpha = alpha;
        if (source) g.drawImage(source, 0, 0, w, h, ox - ax * zoom, oy - ay * zoom, w * zoom, h * zoom);
        else g.drawImage(arts[i], x, y, w, h, ox - ax * zoom, oy - ay * zoom, w * zoom, h * zoom);
      };
      const i = state.current;
      if (!state.playing) {
        if (state.ref >= 0 && state.ref !== i) put(state.ref, tintOf(state.ref, TINTS.ref), .45);
        for (let d = state.before; d >= 1; d--) if (i - d >= 0) put(i - d, tintOf(i - d, TINTS.before), .3 / d);
        for (let d = state.after; d >= 1; d--) if (i + d < count) put(i + d, tintOf(i + d, TINTS.after), .3 / d);
      } else if (state.ref >= 0 && state.ref !== i) put(state.ref, tintOf(state.ref, TINTS.ref), .3);
      put(i, null, 1);
      g.globalAlpha = 1;
      if (zoom >= 8) { // 픽셀 칸(회전 중심이 칸 모서리)
        const left = ((ox % zoom) + zoom) % zoom, top = ((oy % zoom) + zoom) % zoom;
        g.beginPath();
        for (let x = left; x <= width; x += zoom) { g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, height); }
        for (let y = top; y <= height; y += zoom) { g.moveTo(0, Math.round(y) + .5); g.lineTo(width, Math.round(y) + .5); }
        g.strokeStyle = 'rgba(44, 58, 75, .1)'; g.lineWidth = 1; g.stroke();
      }
      g.strokeStyle = 'rgba(79, 128, 255, .9)'; g.lineWidth = 1; // 회전 중심 십자
      g.beginPath(); g.moveTo(ox - 10, oy + .5); g.lineTo(ox + 10, oy + .5); g.moveTo(ox + .5, oy - 10); g.lineTo(ox + .5, oy + 10); g.stroke();
    }
    function render() {
      const changed = changedList();
      state.anchorsChanged = new Set(changed);
      thumbs.forEach((thumb, i) => {
        thumb.classList.toggle('is-current', i === state.current);
        thumb.classList.toggle('is-selected', state.selected.has(i));
        thumb.classList.toggle('is-ref', i === state.ref);
        thumb.classList.toggle('is-moved', moved(i));
      });
      thumbs[state.current]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const [dx, dy] = [start[state.current][0] - frames.anchors[state.current][0], start[state.current][1] - frames.anchors[state.current][1]];
      pickInfo.textContent = `${state.selected.size}개 고름 · 지금 ${state.current + 1}번` + (dx || dy ? ` · 옮긴 거리 ${dx}, ${dy}px` : '');
      refInfo.textContent = state.ref >= 0 ? `${state.ref + 1}번 (${pictures[state.ref].name})` : '없음 · 고정하면 어느 모양을 볼 때나 겹쳐 보입니다.';
      apply.textContent = changed.length ? `적용 (바뀐 모양 ${changed.length}개)` : '적용';
      apply.disabled = state.busy || !changed.length;
      undoButton.disabled = state.busy || !state.past.length;
      redoButton.disabled = state.busy || !state.future.length;
      autoButton.disabled = state.busy || state.selected.size < 2;
      playButton.textContent = state.playing ? '멈춤' : '재생';
      draw();
    }
    const snapshot = () => frames.anchors.map(point => point.slice());
    function remember() { state.past.push(snapshot()); if (state.past.length > 200) state.past.shift(); state.future = []; }
    function travel(from, to) {
      if (state.busy || !from.length) return;
      to.push(snapshot());
      frames.anchors = from.pop();
      render();
    }
    function moveSelected(dx, dy) { // 그림을 (dx, dy)픽셀 옮긴다 = 기준점은 반대로
      for (const i of state.selected) frames.anchors[i] = [frames.anchors[i][0] - dx, frames.anchors[i][1] - dy];
    }
    function autoAlign() {
      if (state.selected.size < 2) { status.textContent = '모양을 두 개 이상 고르세요.'; return; }
      const list = [...state.selected].sort((a, b) => a - b);
      const result = alignAnchors(list.map(i => items[i]), k => frames.anchors[list[k]], () => true);
      remember();
      list.forEach((i, k) => { frames.anchors[i] = result[k]; });
      status.textContent = `고른 모양 ${list.length}개를 자동으로 맞췄습니다(첫 모양 ${list[0] + 1}번은 그대로).`;
      render();
    }
    function resetSelected() {
      remember();
      for (const i of state.selected) frames.anchors[i] = start[i].slice();
      render();
    }
    function togglePlay() {
      if (state.playing) { stopPlay(); render(); return; }
      const list = state.selected.size > 1 ? [...state.selected].sort((a, b) => a - b) : pictures.map((picture, i) => i);
      let k = Math.max(0, list.indexOf(state.current));
      state.playing = setInterval(() => { k = (k + 1) % list.length; state.current = list[k]; draw(); }, 1000 / state.fps);
      render();
    }
    function stopPlay() { if (state.playing) { clearInterval(state.playing); state.playing = 0; } }
    function step(direction) {
      stopPlay();
      const next = clampTo(state.current + direction, 0, count - 1);
      state.current = next; state.last = next; state.selected = new Set([next]);
      render();
    }
    // 화면 끌기: 고른 모양 옮기기(픽셀 단위로 반올림) · 스페이스·가운데·오른쪽 버튼: 화면 이동
    const pointOf = event => { const box = view.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
    view.addEventListener('contextmenu', event => event.preventDefault());
    view.addEventListener('pointerdown', event => {
      if (state.drag || state.busy) return;
      view.focus({ preventScroll: true });
      stopPlay();
      const point = pointOf(event);
      if (event.button === 1 || event.button === 2 || (event.button === 0 && state.space)) {
        state.drag = { kind: 'pan', point, x: state.view.x, y: state.view.y };
      } else if (event.button === 0) {
        if (!state.selected.has(state.current)) state.selected.add(state.current);
        state.drag = { kind: 'move', point, start: snapshot(), moved: false };
      } else return;
      state.drag.id = event.pointerId;
      event.preventDefault();
      view.setPointerCapture(event.pointerId);
    });
    view.addEventListener('pointermove', event => {
      const drag = state.drag;
      if (!drag || drag.id !== event.pointerId) return;
      const point = pointOf(event);
      if (drag.kind === 'pan') {
        state.view = { ...state.view, x: drag.x + point.x - drag.point.x, y: drag.y + point.y - drag.point.y };
        state.autoFit = false; draw(); return;
      }
      const dx = Math.round((point.x - drag.point.x) / state.view.zoom), dy = Math.round((point.y - drag.point.y) / state.view.zoom);
      if (!drag.moved && !dx && !dy) return;
      if (!drag.moved) { drag.moved = true; state.past.push(drag.start); if (state.past.length > 200) state.past.shift(); state.future = []; }
      frames.anchors = drag.start.map(point => point.slice());
      moveSelected(dx, dy);
      render();
    });
    const endDrag = event => { if (state.drag?.id === event.pointerId) { state.drag = null; render(); } };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    const wheelStep = wheelStepper();
    view.addEventListener('wheel', event => {
      event.preventDefault();
      const direction = wheelStep(event);
      if (!direction) return;
      const point = pointOf(event);
      zoomAt(stepZoomFrom(state.view.zoom, direction), point.x, point.y);
    }, { passive: false });
    const resizeWatch = new ResizeObserver(() => draw());
    resizeWatch.observe(view);
    // 키: 창(window)에서 먼저 받아 엔트리(뒤의 편집기)로 가지 않게 한다. 입력칸은 그대로.
    function onKey(event) {
      if (!(event.target instanceof Node) || (!dialog.contains(event.target) && event.target !== document.body)) return;
      if (event.target instanceof Element && event.target.closest('input, select, textarea')) return;
      const key = event.key, mod = event.ctrlKey || event.metaKey;
      const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : '';
      if (key === ' ') {
        state.space = event.type === 'keydown';
        view.style.cursor = state.space ? 'grab' : '';
      } else if (event.type !== 'keydown') return;
      else if (state.busy) { if (key !== 'Escape') return; }
      else if (key.startsWith('Arrow')) {
        const amount = event.shiftKey ? 10 : 1;
        remember(); stopPlay();
        moveSelected(key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0,
          key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0);
        render();
      } else if (key === ',' || key === '<') step(-1);
      else if (key === '.' || key === '>') step(1);
      else if (key === 'Home') step(-count);
      else if (key === 'End') step(count);
      else if (mod && (letter === 'z' || letter === 'y')) { if (letter === 'y' || event.shiftKey) travel(state.future, state.past); else travel(state.past, state.future); }
      else if (mod && letter === 'a') { selectRange(0, count - 1); render(); }
      else if (key === 'Escape') { close(); }
      else return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    function close(force) {
      if (state.busy && !force) return;
      if (!force && changedList().length && !window.confirm('적용하지 않은 이동이 있습니다. 버리고 닫을까요?')) return;
      stopPlay();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      resizeWatch.disconnect();
      backdrop.remove();
      aligner = null;
      alignBusy = false;
      drawPivotUI();
    }
    closeButton.addEventListener('click', () => close());
    cancel.addEventListener('click', () => close());
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); });
    apply.addEventListener('click', async () => {
      const changed = changedList();
      if (!changed.length || state.busy) return;
      stopPlay();
      state.busy = true; render();
      status.textContent = '적용하는 중…';
      try {
        const result = await commitPictureFrames(object, frames, changed, '모양 맞추기 적용 중',
          list => list.length <= changed.length || window.confirm(
            `모양이 커져 같은 크기 틀을 맞추느라 모양 ${list.length}개를 다시 올립니다(바꾼 것 ${changed.length}개). 계속할까요?`));
        if (!result) { status.textContent = '적용하지 않았습니다.'; return; }
        toast(`모양 ${result.done}개에 적용했습니다${result.skipped ? ` (그 사이 바뀐 모양 ${result.skipped}개는 그대로)` : ''}` +
          ' · 되돌리기 가능 · 작품을 저장하세요', 6000);
        close(true);
      } catch (error) {
        status.textContent = `적용 실패: ${error.message} · 다시 누르면 다시 올립니다.`;
      } finally {
        state.busy = false;
        if (aligner) render();
      }
    });
    aligner = { close };
    render();
    view.focus({ preventScroll: true });
    return aligner;
  }
  // 모양 탭의 "스프라이트 나누기": 창으로 띄워 지금 오브젝트에 모양을 넣는다.
  let slicer = null;
  function openSlicer(c) {
    slicer?.close();
    const backdrop = document.createElement('div');
    backdrop.className = 'evr-slicer-backdrop';
    const onKey = event => { if (event.key === 'Escape' && !ui.busy()) ui.close(); };
    const ui = slicerUI({ mode: 'picture', c, onClose() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (slicer === ui) slicer = null;
    } });
    backdrop.append(ui.element);
    backdrop.addEventListener('pointerdown', event => {
      if (event.target === backdrop && !ui.busy()) ui.close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    slicer = ui;
    ui.loadCostume().catch(() => { ui.element.querySelector('.evr-slicer-status').textContent =
      '파일 열기로 시트 그림을 고르세요.'; });
    return ui;
  }
  // ---- 오브젝트 추가하기 창의 "스프라이트 나누기" 탭 ----
  // 엔트리(React)가 그리는 탭 목록 끝에 우리 탭을 붙이고, 누르면 탭 아래 내용 자리를 나누기 화면으로
  // 덮는다. 켜진 탭 표시는 엔트리 탭의 켜짐 클래스(on__…)를 빌리고, 다른 탭을 누르면 돌려준다.
  // 이 탭이 켜져 있으면 오른쪽 위 "추가하기"는 엔트리 동작 대신 새 오브젝트를 만든다.
  let sheetTab = null;
  function addObjectTabs() {
    for (const list of document.querySelectorAll('[class*="popup"] ul')) {
      const texts = [...list.children].map(item => item.textContent.trim());
      if (texts.includes('오브젝트 선택') && texts.includes('글상자')) return list;
    }
    return null;
  }
  function ensureAddObjectTab() {
    const list = addObjectTabs();
    if (sheetTab && sheetTab.list !== list) { deactivateSheetTab(false); sheetTab.li.remove(); sheetTab = null; }
    if (!list) return;
    if (!sheetTab) {
      const li = document.createElement('li');
      li.dataset.evrTab = 'sheet';
      const link = document.createElement('a');
      link.textContent = '스프라이트 나누기';
      link.setAttribute('role', 'button');
      link.addEventListener('click', event => { event.preventDefault(); activateSheetTab(); });
      li.append(link);
      sheetTab = { list, li, active: false, panel: null, ui: null, onClass: '', restore: null,
        wrap: list.closest('[class*="popup_wrap"]') || list.closest('[class*="popup"]') };
    }
    if (sheetTab.li.parentElement !== list) list.append(sheetTab.li);
    if (sheetTab.active) placeSheetPanel();
  }
  function activateSheetTab() {
    const tab = sheetTab;
    if (!tab?.wrap || tab.active) return;
    const on = [...tab.list.children].find(item => item !== tab.li &&
      [...item.classList].some(name => /^on(__|$)/.test(name)));
    tab.onClass = on ? [...on.classList].find(name => /^on(__|$)/.test(name)) : '';
    if (on) on.classList.remove(tab.onClass);
    tab.restore = on || null;
    if (tab.onClass) tab.li.classList.add(tab.onClass);
    tab.panel = document.createElement('div');
    tab.panel.className = 'evr-sheet-panel';
    // 아래 엔트리 내용이 비치지 않게, 탭 목록에서 위로 올라가며 처음 만나는 배경색을 쓴다.
    let background = '';
    for (let node = tab.list; node && !background; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) background = color;
    }
    tab.panel.style.background = background || '#fff';
    tab.ui = slicerUI({ mode: 'object', onClose: () => deactivateSheetTab(true) });
    tab.panel.append(tab.ui.element);
    tab.wrap.append(tab.panel);
    tab.active = true;
    placeSheetPanel();
  }
  // restore가 참이면 빌렸던 켜짐 표시를 원래 탭에 돌려준다(다른 엔트리 탭을 누르면 엔트리가 다시 그림).
  function deactivateSheetTab(restore) {
    const tab = sheetTab;
    if (!tab?.active) return;
    tab.active = false;
    const ui = tab.ui;
    tab.ui = null;
    ui?.close(); // 올리는 중이면 멈춘다(창을 닫거나 다른 탭으로 가면 취소)
    tab.panel?.remove();
    tab.panel = null;
    if (tab.onClass) tab.li.classList.remove(tab.onClass);
    if (restore && tab.onClass && tab.restore?.isConnected) tab.restore.classList.add(tab.onClass);
  }
  function placeSheetPanel() {
    const tab = sheetTab;
    if (!tab?.panel) return;
    const navi = tab.list.closest('[class*="section_navi"]') || tab.list;
    const top = navi.getBoundingClientRect().bottom - tab.wrap.getBoundingClientRect().top;
    if (tab.panel.style.top !== `${top}px`) tab.panel.style.top = `${top}px`;
    // 엔트리가 탭을 다시 그려 원래 켜짐 표시를 되살렸으면 다시 빌린다.
    for (const item of tab.list.children)
      if (item !== tab.li && tab.onClass && item.classList.contains(tab.onClass)) {
        item.classList.remove(tab.onClass);
        tab.restore = item;
      }
  }

  function pathItems(item) {
    const found = [];
    function visit(node) {
      if (node.className === 'Path' || node.className === 'CompoundPath') {
        found.push(node); return;
      }
      if (node.children) node.children.forEach(visit);
    }
    visit(item);
    return found;
  }

  function sourceSvg(sourcePaths) {
    const root = document.createElementNS(NS, 'svg');
    sourcePaths.forEach(data => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', data); root.append(path);
    });
    return root;
  }

  // ---- 레이어별 뼈대: 데이터와 변형 ----
  // 레이어(그림의 맨 위 항목)마다 자기 뼈대를 data.entryVectorBones(JSON 문자열)에 둔다.
  // joints: 기준 모양 위 관절(부모 번호가 항상 앞), pose: 관절마다 부모를 중심으로 돈 각도(도)와 뿌리를 옮긴 거리(rootX, rootY),
  // source: 기준 모양의 경로, sig: 마지막으로 만든 모양의 요약(뼈대 모드 밖에서 고쳤는지 알아보는 데 씀).
  const BONES = 'entryVectorBones';
  const posed = rig => Object.values(rig.pose).some(angle => Math.abs(angle) > 1e-6);
  const radiusOf = item => clean(Math.max(8, Math.min(40,
    Math.min(item.bounds.width, item.bounds.height) / 5)));
  function validRig(rig) {
    return !!rig && Array.isArray(rig.joints) && rig.joints.length > 0 && rig.joints.length <= 1000 &&
      rig.joints.every((j, i) => j.id === i && (i ? Number.isInteger(j.parent) && j.parent >= 0 &&
        j.parent < i : j.parent === -1) && Number.isFinite(j.x) && Number.isFinite(j.y)) &&
      !!rig.pose && typeof rig.pose === 'object' &&
      Object.values(rig.pose).every(angle => Number.isFinite(Number(angle))) &&
      Array.isArray(rig.source) && rig.source.every(data => typeof data === 'string') &&
      Number.isFinite(rig.radius);
  }
  // 레이어 경로를 그림(프로젝트) 좌표로 읽고 쓴다. 관절은 화면에서 찍은 그림 좌표인데, 엔트리 펜 도구로 닫은 경로처럼
  // applyMatrix=false인 항목은 옮기기·돌리기가 점이 아니라 행렬에 남는다(entry-paint 펜 도구 `path.applyMatrix=!1`). 경로 글
  // (pathData)만 읽던 때는 돌린 펜 경로에서 관절과 그림이 어긋났다(실제 엔트리 재현). 복합 경로의 경로 글은 자식 경로의
  // 행렬도 빼고 나오므로(paper 0.12.15 시험: 자식을 90° 돌려도 경로 글은 안 돈 모양) 경로마다 자기 행렬을 넣는다.
  // 행렬이 하나도 없으면 경로 글을 그대로 쓴다. 쓸 때는 경로 글을 넣으면 복합 경로의 자식이 행렬 없이 새로 생기므로
  // 레이어(맨 위 경로) 행렬만 되돌리면 된다.
  function worldPathData(paper, leaf) {
    const nodes = leaf.children || [leaf];
    if (nodes.every(node => node.globalMatrix.isIdentity())) return leaf.pathData;
    const out = new paper.CompoundPath({ insert: false });
    for (const node of nodes) {
      const path = new paper.Path({ segments: node.segments.map(segment => segment.clone()), closed: node.closed, insert: false });
      path.transform(node.globalMatrix);
      out.addChild(path);
    }
    return out.pathData;
  }
  function setWorldPathData(paper, leaf, data) {
    const m = leaf.globalMatrix;
    if (m.isIdentity()) { leaf.pathData = data; return; }
    const path = new paper.CompoundPath({ pathData: data, insert: false });
    path.transform(m.inverted());
    leaf.pathData = path.pathData;
  }
  // 경로 모양 요약(그림 좌표): 점과 손잡이를 0.05 단위로 섞는다. rel은 첫 점 기준이라 평행 이동에는 그대로다.
  function shapeSig(item) {
    const values = [];
    const visit = node => {
      const m = node.segments && node.globalMatrix, plain = !m || m.isIdentity();
      for (const seg of node.segments || []) {
        if (plain) {
          values.push(seg.point.x, seg.point.y, seg.handleIn.x, seg.handleIn.y, seg.handleOut.x, seg.handleOut.y);
          continue;
        }
        const p = m.transform(seg.point), i = m.transform(seg.point.add(seg.handleIn)),
          o = m.transform(seg.point.add(seg.handleOut));
        values.push(p.x, p.y, i.x - p.x, i.y - p.y, o.x - p.x, o.y - p.y);
      }
      (node.children || []).forEach(visit);
    };
    pathItems(item).forEach(visit);
    if (!values.length) return null;
    const [x0, y0] = values;
    const hash = list => {
      let h = 2166136261;
      for (const value of list) h = Math.imul(h ^ Math.round(value * 20), 16777619);
      return `${(h >>> 0).toString(36)}.${list.length}`;
    };
    const rel = values.map((value, i) => i % 6 === 0 ? value - x0 : i % 6 === 1 ? value - y0 : value);
    return { abs: hash(values), rel: hash(rel), x0: clean(x0), y0: clean(y0) };
  }
  function shiftPaths(paths, dx, dy) {
    const warp = new Warp(sourceSvg(paths));
    warp.transform(([x, y]) => [x + dx, y + dy]);
    return warp.paths.map(path => path.pathElement.getAttribute('d'));
  }
  function worlds(joints, pose) {
    const result = [];
    for (const j of joints) result[j.id] = j.parent < 0
      ? [1, 0, 0, 1, Number(pose.rootX) || 0, Number(pose.rootY) || 0] : multiply(result[j.parent],
      rotate(joints[j.parent].x, joints[j.parent].y, Number(pose[j.id]) || 0));
    return result;
  }
  // 관절이 지금 포즈에서 놓인 자리.
  function jointPoints(rig) {
    const world = worlds(rig.joints, rig.pose);
    return rig.joints.map(j => at(world[j.id], j));
  }
  // 지금 보이는 모양을 새 기준으로 삼는다: 관절은 휜 자리(map이 있으면 그 변환을 한 자리)로 옮기고 각도는 0으로.
  function bakeRig(s, rig, item, map) {
    const points = jointPoints(rig).map(p => map ? at(map, p) : p);
    rig.joints = rig.joints.map(j => ({ ...j, x: clean(points[j.id].x), y: clean(points[j.id].y) }));
    rig.pose = {};
    rig.source = pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf));
    rig.sig = shapeSig(item);
  }
  // 뼈대 모드 밖에서 레이어가 바뀌었으면 맞춘다.
  // - 옮기기만 했으면 뼈대와 기준 모양을 같이 옮긴다(자세 그대로).
  // - 엔트리 선택 도구로 돌리기·크기 바꾸기·뒤집기를 했으면 관절도 같은 변환으로 옮기고 지금 모양을 새 기준으로 삼는다.
  //   예전에는 옮기기만 따라가서 돌린 그림 위에 관절이 제자리로 남았다(사용자 "벡터에서 회전하는 거는 안 되더라", 실제 엔트리 재현).
  // - 그 밖에 고쳤으면 지금 모양을 새 기준으로 삼는다(관절은 그 자리).
  function reconcileRig(s, rig, item) {
    const sig = shapeSig(item);
    if (!sig || sig.abs === rig.sig?.abs) return;
    const sameCount = rig.source.length === pathItems(item).length;
    if (rig.sig && sig.rel === rig.sig.rel && sameCount) {
      const dx = sig.x0 - rig.sig.x0, dy = sig.y0 - rig.sig.y0;
      rig.joints = rig.joints.map(j => ({ ...j, x: clean(j.x + dx), y: clean(j.y + dy) }));
      rig.source = shiftPaths(rig.source, dx, dy);
      rig.sig = sig;
    } else bakeRig(s, rig, item, sameCount ? changeSince(s, rig, item) : null);
  }
  // 엔트리의 돌리기·크기·뒤집기는 점 수와 순서를 그대로 두고 모든 점(앵커와 손잡이 끝)에 같은 아핀 변환을 건다. 뼈대 모드가
  // 마지막으로 만든 모양 → 지금 모양을 변환 하나로 설명할 수 있으면 그 변환([a, b, c, d, tx, ty], at()과 같은 꼴)을, 점을
  // 고쳤으면(어느 점이든 0.5px 넘게 어긋나면) null을 돌려준다.
  function changeSince(s, rig, item) {
    const paper = s.ep.paper, leaves = pathItems(item);
    let made;
    try { made = madePaths(s, item, rig, leaves); } catch (error) {
      console.warn('[entry-vector-rig] 돌리기·크기 따라가기 계산 실패(관절은 그 자리에 둠)', error);
      return null;
    }
    const from = [], to = [];
    for (const data of made)
      for (const node of new paper.CompoundPath({ pathData: data, insert: false }).children) addControlPoints(from, node, null);
    for (const leaf of leaves) for (const node of leaf.children || [leaf]) addControlPoints(to, node, node.globalMatrix);
    return from.length === to.length && from.length >= 3 ? fitAffine(from, to, 0.5) : null;
  }
  // 경로 하나의 앵커와 손잡이 끝(m이 있으면 그 행렬로 옮긴 그림 좌표). 닫힌 경로의 마지막 점이 첫 점과 겹치면(0.01px 안)
  // 합쳐 센다: 경로 글로 바꿨다 읽으면 이 겹친 점이 소수 반올림에 따라 합쳐지기도 하고 남기도 해서(실제 엔트리: 엔트리봇
  // 얼굴을 돌린 뒤 한 경로가 10점 → 11점) 양쪽을 같은 꼴로 맞춘다. 합치는 방식은 paper.js Path#join과 같다(마지막 점의
  // 들어오는 손잡이를 첫 점으로).
  function addControlPoints(points, node, m) {
    const move = m && !m.isIdentity() ? point => m.transform(point) : point => point;
    const list = node.segments.map(({ point, handleIn, handleOut }) =>
      [move(point), move(point.add(handleIn)), move(point.add(handleOut))]);
    const first = list[0], last = list[list.length - 1];
    if (node.closed && list.length > 1 && first[0].getDistance(last[0]) < 0.01) {
      list.pop();
      first[1] = first[0].add(last[1].subtract(last[0]));
    }
    for (const tips of list) for (const p of tips) points.push([p.x, p.y]);
  }
  // 점 짝 from[i] → to[i]에 가장 잘 맞는 아핀 변환(최소제곱, 정규방정식). 모든 점이 tolerance 안에 들 때만 돌려준다.
  function fitAffine(from, to, tolerance) {
    const n = from.length;
    let fx = 0, fy = 0, tx = 0, ty = 0;
    for (let i = 0; i < n; i++) { fx += from[i][0]; fy += from[i][1]; tx += to[i][0]; ty += to[i][1]; }
    fx /= n; fy /= n; tx /= n; ty /= n;
    let sxx = 0, sxy = 0, syy = 0, uxx = 0, uxy = 0, vyx = 0, vyy = 0;
    for (let i = 0; i < n; i++) {
      const x = from[i][0] - fx, y = from[i][1] - fy, u = to[i][0] - tx, v = to[i][1] - ty;
      sxx += x * x; sxy += x * y; syy += y * y;
      uxx += u * x; uxy += u * y; vyx += v * x; vyy += v * y;
    }
    const det = sxx * syy - sxy * sxy, spread = sxx + syy;
    if (!(spread > 1e-9)) return null; // 점이 모두 한 자리
    let m;
    if (det > 1e-9 * spread ** 2) {
      const a = (uxx * syy - uxy * sxy) / det, c = (uxy * sxx - uxx * sxy) / det;
      const b = (vyx * syy - vyy * sxy) / det, d = (vyy * sxx - vyx * sxy) / det;
      if (Math.abs(a * d - b * c) < 1e-6) return null;
      m = [a, b, c, d, tx - a * fx - c * fy, ty - b * fx - d * fy];
    } else {
      // 점이 모두 한 줄 위(직선 하나뿐인 레이어)면 아핀 변환이 하나로 정해지지 않는다(시험: 직선 레이어를 돌려도 관절이
      // 그대로였음). 이때는 돌리기·균일 크기·옮기기만 최소제곱으로 구한다(2차원 Umeyama 1991, 복소수 꼴 q = (a + ib)p + t).
      // 줄 위의 점은 뒤집기도 이 변환으로 똑같이 옮겨진다.
      const a = (uxx + vyy) / spread, b = (vyx - uxy) / spread;
      if (Math.hypot(a, b) < 1e-6) return null;
      m = [a, b, -b, a, tx - a * fx + b * fy, ty - b * fx - a * fy];
    }
    for (let i = 0; i < n; i++) {
      const p = at(m, { x: from[i][0], y: from[i][1] });
      if (Math.hypot(p.x - to[i][0], p.y - to[i][1]) > tolerance) return null;
    }
    return m;
  }
  // 예전 형식(그림 전체에 뼈대 하나, entry-vector-skin/1): 연결돼 있던 레이어마다 그 뼈대를 지금 포즈
  // 자리 그대로 복사하고 지금 보이는 모양을 기준으로 삼는다. 예전 데이터 칸은 지운다.
  function migrateOldSkin(s) {
    const holder = s.art.find(item => item.data?.entryVectorSkin);
    try {
      const old = holder && JSON.parse(holder.data.entryVectorSkin);
      if (old?.schema === 'entry-vector-skin/1' && Array.isArray(old.joints) && old.joints.length &&
          old.bindings && typeof old.bindings === 'object') {
        const center = artBounds(s)?.center;
        const dx = old.center && center ? center.x - old.center.x : 0;
        const dy = old.center && center ? center.y - old.center.y : 0;
        const points = jointPoints({ joints: old.joints, pose: old.applied || {} });
        const joints = old.joints.map(j => ({ id: j.id, parent: j.parent,
          x: clean(points[j.id].x + dx), y: clean(points[j.id].y + dy) }));
        for (const id of Object.keys(old.bindings)) {
          const item = s.layers.find(layer => layer.data?.entryVectorSkinPiece === id);
          if (!item || item.data[BONES]) continue;
          const rig = { joints: copy(joints), pose: {},
            source: pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf)), radius: radiusOf(item), sig: shapeSig(item) };
          if (validRig(rig)) item.data[BONES] = JSON.stringify(rig);
        }
      }
    } catch (error) { console.warn('[entry-vector-rig] 예전 뼈대 변환 실패', error); }
    for (const item of s.art) {
      delete item.data?.entryVectorSkin;
      delete item.data?.entryVectorSkinPiece;
    }
  }

  function makeSession(c, opener) {
    const art = artItems(c);
    const s = { ...c, art, layers: art.filter(item => pathItems(item).length), opener,
      rigs: new Map(), base: new Map(), current: null, selectedJoint: -1, hover: null,
      stage: 'setup', ik: false, previews: new Map(), restBounds: new Map(),
      dragging: null, ui: null, overlay: null, history: [], historyIndex: 0, cache: new Map() };
    migrateOldSkin(s);
    for (const item of s.layers) {
      let rig = null;
      try { rig = JSON.parse(item.data?.[BONES] || 'null'); } catch { /* 깨진 데이터는 쓰지 않는다 */ }
      if (!validRig(rig)) continue;
      rig.pose = Object.fromEntries(Object.entries(rig.pose).map(([id, angle]) => [id, Number(angle)]));
      reconcileRig(s, rig, item);
      item.data[BONES] = JSON.stringify(rig);
      s.rigs.set(item, rig);
      touch(s, item);
    }
    const first = s.layers.length === 1 ? s.layers[0] : s.layers.find(item => s.rigs.has(item));
    s.current = first || null;
    const rig = s.rigs.get(s.current);
    s.selectedJoint = rig ? rig.joints.length - 1 : -1;
    s.stage = rig && rig.joints.length > 1 ? 'pose' : 'setup'; // 뼈가 있으면 바로 자세 잡기
    s.history = [snapshot(s)];
    return s;
  }

  function current(s) {
    const c = context();
    return c && c.ep === s.ep && c.object.id === s.object.id &&
      c.picture.id === s.picture.id && c.layer === s.layer;
  }
  function status(s, message) {
    if (s.ui) s.ui.hint.textContent = s.ui.hint.title = message; // 잘리면 마우스를 올려 전체를 본다
  }
  // 이 레이어를 처음 건드리기 전 상태. 되돌리기 기록에 아직 없는 레이어는 이 상태로 돌린다.
  function touch(s, item) {
    if (s.base.has(item)) return;
    const rig = s.rigs.get(item);
    s.base.set(item, { rig: rig ? copy(rig) : null, paths: pathItems(item).map(leaf => leaf.pathData) });
  }
  function persist(s, item) {
    const rig = s.rigs.get(item);
    if (rig) item.data[BONES] = JSON.stringify(rig);
    else delete item.data[BONES];
    s.p.file.modified = true;
  }
  function snapshot(s) {
    return JSON.stringify([...s.base.keys()].map(item => ({ i: s.layers.indexOf(item),
      rig: s.rigs.get(item) || null, paths: pathItems(item).map(leaf => leaf.pathData) })));
  }
  function checkpoint(s) {
    const next = snapshot(s);
    if (s.history[s.historyIndex] === next) return;
    s.history.splice(s.historyIndex + 1);
    s.history.push(next);
    if (s.history.length > 60) s.history.shift();
    s.historyIndex = s.history.length - 1;
    refreshHistoryButtons(s);
  }
  function refreshHistoryButtons(s) {
    if (!s.ui) return;
    s.ui.undo.disabled = s.historyIndex <= 0;
    s.ui.redo.disabled = s.historyIndex >= s.history.length - 1;
  }
  function historyStep(s, direction) {
    const index = s.historyIndex + direction;
    if (index < 0 || index >= s.history.length || !current(s)) return;
    const states = new Map(JSON.parse(s.history[index]).map(state => [state.i, state]));
    for (const [item, base] of s.base) {
      const state = states.get(s.layers.indexOf(item)) || base;
      const leaves = pathItems(item);
      if (state.paths.length === leaves.length)
        leaves.forEach((leaf, i) => { leaf.pathData = state.paths[i]; });
      if (state.rig) s.rigs.set(item, copy(state.rig));
      else s.rigs.delete(item);
      s.cache.delete(item);
      persist(s, item);
    }
    s.historyIndex = index;
    const rig = s.rigs.get(s.current);
    s.selectedJoint = rig ? Math.min(Math.max(s.selectedJoint, 0), rig.joints.length - 1) : -1;
    s.ep.paper.view.update();
    refreshRigUI(s); refreshHistoryButtons(s); draw(s);
    status(s, direction < 0 ? '되돌렸습니다 · 엔트리 저장 필요' : '다시 했습니다 · 엔트리 저장 필요');
  }

  function segmentDistance(x, y, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1,
      ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
  }
  // ---- 뼈대 굽힘: 표준 스키닝 ----
  // 사용자 요청(2026-10-09 "따로 알고리즘 만들지 마")으로 직접 만든 굽힘(관절 원호·같이 도는 범위 규칙 등) 대신 업계 표준
  // 순서를 그대로 쓴다. 비교 시험(굵기 44 팔 90·100·150°, 관절 6개 꼬리, 몸통+팔 한 레이어)에서 접힘 0~3, 굵기 유지, 몸통 안 끌림.
  //  1) 그림 안을 삼각망으로 나눈다: 경로 경계와 안쪽 격자 점 → delaunator(ISC) 들로네 삼각분할 → 칠해진 곳 안 삼각형만.
  //  2) 자동 가중치 bone heat(Baran & Popović 2007 "Automatic Rigging and Animation of 3D Characters" 4절, Blender "Automatic
  //     Weights"와 같은 방식): −Δwⁱ + H wⁱ = H pⁱ. Δ는 cot 라플라시안(Meyer 외 2003), H_jj = c/d(j)²(꼭짓점 j에서 가장 가까운
  //     뼈까지 선분이 그림 안일 때, 아니면 0), pⁱ_j = 1(가장 가까운 뼈가 i; 같은 거리 k개면 1/k씩, H는 k배), c = HEAT_C.
  //     굽는 폭은 c 하나로 정한다(작을수록 넓게 퍼짐). Blender 원본(meshlaplacian.cc: C_WEIGHT 1, 넓이 정규화 0.5/varea,
  //     법선 보정 dist/(0.5·(cos+1.001)))을 이 식으로 옮기면 평평한 2D 그림에서 c ≈ 1이다. c = 1·0.3·0.15·0.1·0.05·0.03을
  //     같은 그림들에 돌려 비교해 0.1을 골랐다: 1은 관절이 경첩처럼 꺾여 안쪽이 접히고(시험 묶음 늘어난 교차 11), 0.1은 교차
  //     1·접힘선 깔끔, 0.05부터는 한 레이어의 몸통이 팔을 따라 기울었다. 대신 굵은 팔(130px)을 144° 접으면 관절에서 135px
  //     넘게 떨어진 곳도 6~11px 따라 움직인다.
  //     예전엔 그 뒤에 이웃 꼭짓점 평균(Spine "Smooth"류)을 60번 했는데, 불규칙한 삼각망에서 가중치가 울퉁불퉁해져 윤곽선이
  //     물결쳤고(사용자 화면) 먼 곳까지 번져 굵은 팔은 관절에서 150px 떨어진 곳이 22px 움직였다. Blender의 작은 가중치
  //     자르기(0.025 아래 0, 0.05까지 이어 줄임)도 시험했지만 관절에서 먼 곳의 작은 차이가 커져 꺾임이 생겨 쓰지 않는다.
  //  3) 듀얼 쿼터니언 스키닝(Kavan 외 2008, gl-matrix quat2(MIT)). 선형 블렌드(LBS)는 굽힐수록 관절이 얇아져(시험: 90°에서
  //     굵기 44 → 32.5) 쓰지 않는다. 알려진 약점: 크게 굽히면 관절이 조금 부푼다.
  // 경로는 정점 스키닝으로 옮긴다: 곡선을 삼각망 간격 이하로 나눠(모양 그대로) 그 앵커들을 삼각망 꼭짓점으로 넣고, 앵커와
  // 손잡이 끝점을 각자 자리 가중치로 섞은 변환으로 옮긴다(Rive 런타임 CubicVertex::deform이 곡선 in/out 점을 각자 가중치로
  // 옮기는 방식). 같은 자리 앵커(채우기와 윤곽선이 맞닿은 선)는 한 꼭짓점이라 함께 움직인다. 손잡이를 앵커 회전으로만 돌리던
  // 때는 가중치가 바뀌는 곳에서 곡선마다 S자로 꿀렁였다(사용자 화면, 굵은 선 팔 144° 재현). 처음엔 아무 점의 가중치를 삼각형 안 보간·밖이면 가장 가까운 꼭짓점으로 구하고 곡선을 쪼개
  // 맞췄는데, 변형이 삼각형 경계에서 꺾이고 밖에서 끊겨 윤곽선에 톱니가 생겼다(사용자 화면, 시험 재현).
  // 예전 기록: 처음 방식(가까운 뼈 4개 회전 위치를 거리로 평균)은 굽는 곳이 얇아지고(40 막대 90°에서 27.7) 수십 군데 꺾였고,
  // 그다음 관절 둘레 회전 나누기는 팔꿈치 혹·갈고리가 생겼으며, 관절 원호 굽힘은 직접 조합한 규칙이 많았다.
  const HEAT_C = 0.1;
  const glm = () => {
    const lib = window.glMatrix;
    if (!lib?.quat2) throw Error('gl-matrix를 불러오지 못했습니다(확장 vendor 파일 확인).');
    lib.glMatrix.setMatrixArrayType(Array); // 소수 정밀도(Float32 대신 Float64)
    return lib;
  };
  // 칠해진 곳(채우기 안쪽 또는 선 굵기 절반 안) 판정. leaves(지금 레이어의 경로)에서 채우기·선 굵기를 읽는다(없으면 모두 채움).
  function inkOf(paths, leaves) {
    const visible = color => !!color && (color.alpha === undefined || color.alpha > 0);
    const styles = paths.map((path, i) => {
      const leaf = leaves?.[i];
      const stroke = leaf && visible(leaf.strokeColor) ? Number(leaf.strokeWidth) || 0 : 0;
      return { fill: leaf ? visible(leaf.fillColor) : true, stroke, bounds: path.bounds.expand(stroke + 1) };
    });
    const ink = point => paths.some((path, i) => {
      const style = styles[i];
      if (!style.bounds.contains(point)) return false;
      if (style.fill && path.contains(point)) return true;
      if (!style.stroke) return false;
      const near = path.getNearestPoint(point);
      return !!near && near.getDistance(point) <= style.stroke / 2;
    });
    return { ink, styles };
  }
  // 곡선을 나눠 앵커 사이를 spacing 이하로(모양은 그대로). 스키닝은 이 앵커와 손잡이만 옮긴다. 직선 조각은 같은 직선을
  // 그리는 3차 곡선(손잡이를 양 끝에서 1/3, 차수 올리기)으로 바꿔 둔다 — 손잡이가 없으면 휘어도 앵커 사이가 직선이라 각진다.
  function densePaths(paths, spacing) {
    return paths.map(path => {
      const copy = path.clone({ insert: false });
      for (const leaf of copy.className === 'CompoundPath' ? copy.children : [copy]) {
        for (const curve of leaf.curves) {
          if (curve.hasHandles()) continue;
          const third = curve.point2.subtract(curve.point1).divide(3);
          curve.handle1 = third;
          curve.handle2 = third.negate();
        }
        const cuts = [];
        let start = 0;
        for (const curve of leaf.curves) {
          const length = curve.length, parts = Math.ceil(length / spacing);
          for (let k = 1; k < parts; k++) cuts.push(start + length * k / parts);
          start += length;
        }
        for (let i = cuts.length - 1; i >= 0; i--) leaf.divideAt(cuts[i]);
      }
      return copy;
    });
  }
  // 1) 삼각망: 나눈 경로의 앵커(선이 있으면 앵커에서 선 양쪽 가장자리도)와 안쪽 격자 점을 들로네 삼각분할하고, 칠해진 곳 안
  // 삼각형만 남긴다. 같은 자리 앵커는 한 꼭짓점. anchors[경로][하위 경로][앵커] = 꼭짓점 번호.
  // 점 간격은 그림 상자 크기에 비례해 꼭짓점이 200개쯤 되게(2~24px). 꼭짓점 수(1500·400·200)를 같은 그림들에 돌려 비교해
  // 골랐다(그때는 이웃 평균 매끄럽게와 함께; 앵커를 3~8px로 더 촘촘히 하면 윤곽선 고리 팔의 톱니가 오히려 늘었다).
  function skinMesh(paper, paths, styles, ink) {
    let bounds = null;
    for (const path of paths) bounds = bounds ? bounds.unite(path.bounds) : path.bounds;
    const spacing = Math.max(2, Math.min(24, Math.sqrt(bounds.width * bounds.height / 200)));
    const dense = densePaths(paths, spacing), pts = [], at = new Map();
    const vertex = (x, y) => {
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      if (!at.has(key)) { at.set(key, pts.length / 2); pts.push(x, y); }
      return at.get(key);
    };
    const anchors = dense.map((path, i) => {
      const half = styles[i].stroke / 2;
      return (path.className === 'CompoundPath' ? path.children : [path]).map(leaf => {
        const segments = leaf.segments;
        return segments.map((segment, k) => {
          const q = segment.point;
          if (half) { // 앵커 양옆 선 가장자리(이웃 앵커로 잰 방향의 수직)
            const a = segments[k ? k - 1 : leaf.closed ? segments.length - 1 : k].point;
            const b = segments[k < segments.length - 1 ? k + 1 : leaf.closed ? 0 : k].point;
            const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
            if (length > 1e-9) { vertex(q.x - dy / length * half, q.y + dx / length * half); vertex(q.x + dy / length * half, q.y - dx / length * half); }
          }
          return vertex(q.x, q.y);
        });
      });
    });
    const near = spacing / 2;
    for (let x = bounds.left + near; x < bounds.right; x += spacing) for (let y = bounds.top + near; y < bounds.bottom; y += spacing) {
      const P = (dx, dy) => new paper.Point(x + dx, y + dy);
      if (ink(P(0, 0)) && ink(P(near, 0)) && ink(P(-near, 0)) && ink(P(0, near)) && ink(P(0, -near))) vertex(x, y);
    }
    const tris = [];
    if (pts.length >= 6) {
      const d = new window.Delaunator(pts);
      for (let k = 0; k < d.triangles.length; k += 3) {
        const a = d.triangles[k], b = d.triangles[k + 1], c = d.triangles[k + 2];
        if (ink(new paper.Point((pts[2 * a] + pts[2 * b] + pts[2 * c]) / 3, (pts[2 * a + 1] + pts[2 * b + 1] + pts[2 * c + 1]) / 3)))
          tris.push(a, b, c);
      }
    }
    return { pts, tris, n: pts.length / 2, spacing, dense, anchors };
  }
  // 2) bone heat 자동 가중치(Baran & Popović 2007 4절). 뼈 = 부모가 있는 관절 번호.
  function heatWeights(paper, mesh, rig, ink) {
    const { pts, tris, n } = mesh, joints = rig.joints, bones = joints.filter(j => j.parent >= 0).map(j => j.id);
    const L = Array.from({ length: n }, () => new Map()), A = new Float64Array(n);
    const add = (i, j, v) => { L[i].set(j, (L[i].get(j) || 0) + v); };
    const px = i => pts[2 * i], py = i => pts[2 * i + 1];
    for (let k = 0; k < tris.length; k += 3) {
      const v = [tris[k], tris[k + 1], tris[k + 2]];
      const area = Math.abs((px(v[1]) - px(v[0])) * (py(v[2]) - py(v[0])) - (px(v[2]) - px(v[0])) * (py(v[1]) - py(v[0]))) / 2;
      if (area < 1e-9) continue;
      for (let c = 0; c < 3; c++) { // 꼭짓점 o의 각의 cot → 마주 보는 변 (a, b)
        const o = v[c], a = v[(c + 1) % 3], b = v[(c + 2) % 3];
        const ux = px(a) - px(o), uy = py(a) - py(o), wx = px(b) - px(o), wy = py(b) - py(o);
        const cot = (ux * wx + uy * wy) / Math.abs(ux * wy - uy * wx) / 2;
        add(a, b, -cot); add(b, a, -cot); add(a, a, cot); add(b, b, cot);
        A[o] += area / 3;
      }
    }
    const H = new Float64Array(n), p = bones.map(() => new Float64Array(n));
    const seen = (x0, y0, x1, y1) => { // 꼭짓점에서 뼈 위 가장 가까운 점까지 선분이 그림 안인가
      for (let s = 1; s < 8; s++) if (!ink(new paper.Point(x0 + (x1 - x0) * s / 8, y0 + (y1 - y0) * s / 8))) return false;
      return true;
    };
    for (let i = 0; i < n; i++) {
      const x = px(i), y = py(i);
      const ds = bones.map(id => segmentDistance(x, y, joints[joints[id].parent], joints[id]));
      const dmin = Math.max(Math.min(...ds), .5);
      const nearest = bones.map((id, b) => b).filter(b => ds[b] <= dmin * 1.01 + 1e-9).filter(b => {
        const a = joints[joints[bones[b]].parent], z = joints[bones[b]], dx = z.x - a.x, dy = z.y - a.y;
        const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return seen(x, y, a.x + u * dx, a.y + u * dy);
      });
      if (!nearest.length) continue;
      H[i] = HEAT_C * nearest.length / (dmin * dmin);
      for (const b of nearest) p[b][i] = 1 / nearest.length;
    }
    // (L + A·H) w = A·H·p 는 대칭 양의 정부호 → 켤레 기울기법(야코비 전처리)
    const diag = new Float64Array(n);
    for (let i = 0; i < n; i++) diag[i] = (L[i].get(i) || 0) + A[i] * H[i];
    const mul = (x, out) => { for (let i = 0; i < n; i++) { let s = A[i] * H[i] * x[i]; for (const [j, v] of L[i]) s += v * x[j]; out[i] = s; } };
    const solve = rhs => {
      const x = new Float64Array(n), r = Float64Array.from(rhs), z = new Float64Array(n), q = new Float64Array(n);
      for (let i = 0; i < n; i++) z[i] = r[i] / (diag[i] || 1);
      const d = Float64Array.from(z);
      let rz = 0;
      for (let i = 0; i < n; i++) rz += r[i] * z[i];
      for (let it = 0; it < 2000 && rz > 1e-14; it++) {
        mul(d, q);
        let dq = 0;
        for (let i = 0; i < n; i++) dq += d[i] * q[i];
        const alpha = rz / dq;
        for (let i = 0; i < n; i++) { x[i] += alpha * d[i]; r[i] -= alpha * q[i]; z[i] = r[i] / (diag[i] || 1); }
        let next = 0;
        for (let i = 0; i < n; i++) next += r[i] * z[i];
        const beta = next / rz;
        rz = next;
        for (let i = 0; i < n; i++) d[i] = z[i] + beta * d[i];
      }
      return x;
    };
    const W = p.map(pb => solve(pb.map((v, i) => A[i] * H[i] * v)));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const w of W) { w[i] = Math.max(0, w[i]); sum += w[i]; }
      if (sum > 0) for (const w of W) w[i] /= sum;
    }
    return { bones, W };
  }
  // 한 점의 가중치: 그 점이 든 삼각형 꼭짓점 가중치를 무게중심 좌표로 섞는다(선형 유한요소 보간). 삼각망 밖이면 가장 가까운
  // 삼각형 위 점의 값(밖에서도 끊기지 않게). 손잡이 끝점에 쓴다.
  function weightsAt(mesh, W, x, y) {
    const { pts, tris } = mesh;
    let best = null, bestDistance = Infinity;
    const edge = (a, b, ta, tb) => { // 변 a-b 위 가장 가까운 점
      const ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const distance = Math.hypot(ax + u * dx - x, ay + u * dy - y);
      if (distance < bestDistance) { bestDistance = distance; best = [[a, 1 - u], [b, u]]; }
    };
    for (let k = 0; k < tris.length && bestDistance > 0; k += 3) {
      const a = tris[k], b = tris[k + 1], c = tris[k + 2];
      const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1], cx = pts[2 * c], cy = pts[2 * c + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) { best = [[a, u], [b, v], [c, 1 - u - v]]; bestDistance = 0; break; }
      edge(a, b); edge(b, c); edge(c, a);
    }
    return best && W.map(w => best.reduce((sum, [i, f]) => sum + f * w[i], 0));
  }
  // 기준 모양 경로·삼각망·자동 가중치. 기준 모양이나 관절이 바뀔 때만 다시 만든다.
  function cachedSkin(s, item, rig, leaves) {
    const key = rig.source.join('\n') + JSON.stringify(rig.joints);
    let cached = s.cache.get(item);
    if (cached?.key === key) return cached;
    const paper = s.ep.paper;
    const paths = rig.source.map(data => new paper.CompoundPath({ pathData: data, insert: false }));
    const { ink, styles } = inkOf(paths, leaves);
    const mesh = skinMesh(paper, paths, styles, ink);
    const heat = heatWeights(paper, mesh, rig, ink);
    // 어느 삼각형에도 이어지지 않아 가중치가 모두 0인 꼭짓점은 가장 가까운 뼈 하나를 따른다.
    for (let i = 0; i < mesh.n; i++) {
      if (heat.W.some(w => w[i] > 0)) continue;
      const x = mesh.pts[2 * i], y = mesh.pts[2 * i + 1];
      const ds = heat.bones.map(id => segmentDistance(x, y, rig.joints[rig.joints[id].parent], rig.joints[id]));
      heat.W[ds.indexOf(Math.min(...ds))][i] = 1;
    }
    // 손잡이 끝점 가중치: tips[경로][하위 경로][앵커] = { in, out } (손잡이가 없으면 null — 앵커와 같이 움직임)
    const tips = mesh.dense.map(path => (path.className === 'CompoundPath' ? path.children : [path]).map(leaf => leaf.segments.map(segment => {
      const at = handle => handle.isZero() ? null : weightsAt(mesh, heat.W, segment.point.x + handle.x, segment.point.y + handle.y);
      return { in: at(segment.handleIn), out: at(segment.handleOut) };
    })));
    cached = { key, mesh, heat, tips };
    s.cache.set(item, cached);
    return cached;
  }
  // 3) 듀얼 쿼터니언 스키닝: 앵커와 손잡이 끝점마다 가중치로 뼈 변환(듀얼 쿼터니언)을 섞어 정규화해 그 변환으로 옮긴다.
  function skinPathData(paper, skin, rig) {
    const { quat, quat2, vec3 } = glm(), world = worlds(rig.joints, rig.pose);
    const dq = skin.heat.bones.map(id => {
      const m = world[id], q = quat.setAxisAngle(quat.create(), [0, 0, 1], Math.atan2(m[1], m[0]));
      return quat2.fromRotationTranslation(quat2.create(), q, [m[4], m[5], 0]);
    });
    const part = quat2.create();
    const mix = weightOf => {
      const acc = [0, 0, 0, 0, 0, 0, 0, 0]; // quat2.create()는 0이 아니라 항등 변환이라 섞으면 덜 돈다(시험: 90°가 45°쯤)
      let pivot = -1;
      skin.heat.W.forEach((w, b) => {
        const weight = weightOf(w, b);
        if (!(weight > 0)) return;
        if (pivot < 0) pivot = b;
        quat2.scale(part, dq[b], quat2.dot(dq[pivot], dq[b]) < 0 ? -weight : weight); // 짧은 쪽으로 섞는다
        quat2.add(acc, acc, part);
      });
      if (pivot < 0) return null;
      quat2.normalize(acc, acc);
      return { real: quat2.getReal(quat.create(), acc), move: quat2.getTranslation(vec3.create(), acc) };
    };
    const blended = new Map();
    const anchorTransform = index => {
      if (!blended.has(index)) blended.set(index, mix(w => w[index]));
      return blended.get(index);
    };
    const place = (t, x, y) => {
      if (!t) return new paper.Point(x, y);
      const q = vec3.transformQuat(vec3.create(), [x, y, 0], t.real);
      return new paper.Point(q[0] + t.move[0], q[1] + t.move[1]);
    };
    return skin.mesh.dense.map((path, p) => {
      const out = new paper.CompoundPath({ insert: false });
      (path.className === 'CompoundPath' ? path.children : [path]).forEach((leaf, l) => {
        const segments = leaf.segments.map((segment, k) => {
          const point = segment.point, anchor = place(anchorTransform(skin.mesh.anchors[p][l][k]), point.x, point.y);
          const tip = (handle, weights) => {
            if (handle.isZero()) return handle.clone();
            const t = weights ? mix((w, b) => weights[b]) : anchorTransform(skin.mesh.anchors[p][l][k]);
            return place(t, point.x + handle.x, point.y + handle.y).subtract(anchor);
          };
          const weights = skin.tips[p][l][k];
          return new paper.Segment(anchor, tip(segment.handleIn, weights.in), tip(segment.handleOut, weights.out));
        });
        out.addChild(new paper.Path({ segments, closed: leaf.closed, insert: false }));
      });
      return out.pathData;
    });
  }
  // 지금 각도로 휜 경로(그림 좌표). 각도가 모두 0이면 기준 모양 그대로.
  function madePaths(s, item, rig, leaves) {
    return posed(rig) && rig.joints.length > 1 ?
      skinPathData(s.ep.paper, cachedSkin(s, item, rig, leaves), rig) : rig.source;
  }
  // 기준 모양에서 지금 각도로 다시 휜다(끌 때마다 쌓이는 오차 없음).
  function deformLayer(s, item) {
    const rig = s.rigs.get(item), leaves = pathItems(item);
    if (!rig) return;
    if (leaves.length !== rig.source.length)
      throw Error('레이어의 경로 구조가 달라져 휘기를 멈췄습니다.');
    const data = madePaths(s, item, rig, leaves);
    leaves.forEach((leaf, i) => setWorldPathData(s.ep.paper, leaf, data[i]));
    rig.sig = shapeSig(item);
    s.ep.paper.view.update();
  }

  function pointer(s, event) {
    const rect = s.canvas.getBoundingClientRect(), size = s.ep.paper.view.viewSize;
    const view = new s.ep.paper.Point((event.clientX - rect.left) * size.width / rect.width,
      (event.clientY - rect.top) * size.height / rect.height);
    const p = s.ep.paper.view.viewToProject(view);
    return { x: p.x, y: p.y };
  }
  function screen(s, p) {
    const view = s.ep.paper.view.projectToView(new s.ep.paper.Point(p.x, p.y));
    const rect = s.canvas.getBoundingClientRect(), size = s.ep.paper.view.viewSize;
    return { x: view.x * rect.width / size.width, y: view.y * rect.height / size.height };
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function writePivot(c, point, requestedOffset) {
    if (canvasBox(c) || hasNativeCanvas(c.object)) {
      ensureCanvasBox(c);
      c.p.file.modified = true;
      drawPivotUI();
      if (session) draw(session);
      return;
    }
    const position = { x: clean(point.x), y: clean(point.y) };
    const previous = c.picture.dimension.entryVectorPivot;
    const offset = validPivot(requestedOffset) ?
      { dx: clean(requestedOffset.dx), dy: clean(requestedOffset.dy) } :
      validPivot(previous) ? copy(previous) :
        { dx: clean(position.x - c.layer.bounds.center.x),
          dy: clean(position.y - c.layer.bounds.center.y) };
    const entity = c.object.entity;
    const baseline = { dx: clean(entity.getRegX() - entity.getWidth() / 2),
      dy: clean(entity.getRegY() - entity.getHeight() / 2) };
    c.object.pictures.forEach(picture => {
      if (picture !== c.picture && !validPivot(picture.dimension.entryVectorPivot)) {
        picture.dimension.entryVectorPivot = copy(baseline);
        rememberPivot(c.object, picture, baseline);
      }
    });
    c.picture.dimension.entryVectorPivot = offset;
    rememberPivot(c.object, c.picture, offset);
    entity.setRegX(entity.getWidth() / 2 + offset.dx);
    entity.setRegY(entity.getHeight() / 2 + offset.dy);
    c.E.stage.updateObject();
    c.p.file.modified = true;
    if (pivotUI && pivotUI.object === c.object &&
        pivotUI.picture.id === c.picture.id) pivotUI.point = position;
    drawPivotUI();
    if (session) draw(session);
  }
  function drawPivotUI() {
    const p = pivotUI;
    if (!p || !p.overlay.isConnected) return;
    const canvasRect = p.canvas.getBoundingClientRect();
    const viewSize = p.ep.paper.view.viewSize;
    if (canvasRect.width < 1 || canvasRect.height < 1 ||
        viewSize.width < 1 || viewSize.height < 1 ||
        !Number.isFinite(p.point.x) || !Number.isFinite(p.point.y)) return;
    const areaBox = p.overlay.parentElement.getBoundingClientRect();
    Object.assign(p.overlay.style, { left: `${canvasRect.left - areaBox.left}px`,
      top: `${canvasRect.top - areaBox.top}px`, width: `${canvasRect.width}px`,
      height: `${canvasRect.height}px` });
    p.overlay.setAttribute('viewBox', `0 0 ${canvasRect.width} ${canvasRect.height}`);
    const marker = screen(p, p.point);
    if (![marker.x, marker.y].every(Number.isFinite)) return;
    p.marker.setAttribute('transform', `translate(${marker.x} ${marker.y})`);
    const onion = p.costumeOnion;
    Object.assign(onion.style, { left: `${canvasRect.left - areaBox.left}px`,
      top: `${canvasRect.top - areaBox.top}px`, width: `${canvasRect.width}px`,
      height: `${canvasRect.height}px` });
    onion.setAttribute('viewBox', `0 0 ${canvasRect.width} ${canvasRect.height}`);
    const pictures = p.object.pictures;
    const index = pictures.findIndex(picture => picture.id === p.picture.id);
    const pinned = pictures.findIndex(picture => picture.id === pinnedPictures.get(p.object.id));
    // svg 요소에는 hidden 속성 기능이 없어(크롬 154: SVGElement에 hidden 없음) onion.hidden = …은 값만 남기고 화면은 그대로였다
    // (끄거나 기준 모양을 풀어도 다른 모양을 누를 때까지 겹쳐 보기가 남음). 속성으로 직접 둔다(CSS [hidden] → display: none).
    const hide = !costumeOnionEnabled && (pinned < 0 || pinned === index);
    onion.toggleAttribute('hidden', hide);
    if (hide) return;
    const neighbors = costumeOnionEnabled ? [index - 1, index + 1].filter(i => i >= 0 && i < pictures.length) : [];
    if (pinned >= 0 && pinned !== index && !neighbors.includes(pinned)) neighbors.push(pinned);
    const viewKey = JSON.stringify([p.picture.id, pinned, neighbors.map(i => [i,
      pictures[i].id, pictures[i].fileurl, pictures[i].dimension?.width,
      pictures[i].dimension?.height]), p.ep.paper.view.matrix.values,
      canvasRect.width, canvasRect.height, p.point]);
    if (p.costumeOnionKey === viewKey) return;
    p.costumeOnionKey = viewKey;
    onion.replaceChildren();
    // 엔트리 최대 배율(250%)을 넘겨 보면 편집기 비트맵처럼 겹쳐 보기 그림도 픽셀 그대로(보간 없이) 그린다.
    const crisp = p.ep.paper.view.zoom > ENTRY_ZOOM_MAX + 1e-9 ? { style: 'image-rendering:pixelated' } : {};
    for (const i of neighbors) {
      const picture = pictures[i];
      const width = Number(picture.dimension?.width);
      const height = Number(picture.dimension?.height);
      if (!(width > 0 && height > 0)) continue;
      const a = screen(p, { x: p.point.x - width / 2,
        y: p.point.y - height / 2 });
      const z = screen(p, { x: p.point.x + width / 2,
        y: p.point.y + height / 2 });
      const href = new URL(p.p.getImageSrc(picture), location.href).href;
      onion.append(svg('image', { href, x: Math.min(a.x, z.x),
        y: Math.min(a.y, z.y), width: Math.abs(z.x - a.x),
        height: Math.abs(z.y - a.y), opacity: i === pinned ? '.45' : '.32',
        'data-index': i, 'data-side': i === pinned ? 'pinned' : i < index ? 'previous' : 'next',
        preserveAspectRatio: 'none', ...crisp }));
    }
  }
  function refreshPivotUI(c) {
    if (!c) {
      const root = document.getElementById('entryPainter');
      const mode = window.Entry?.playground?.painter?.entryPaint?.mode;
      if (!root?.getClientRects().length || !['VECTOR', 'BITMAP'].includes(mode)) {
        pivotUI?.overlay.remove(); pivotUI?.costumeOnion.remove(); pivotUI = null;
      }
      return;
    }
    const viewCenter = homeCenter(c.ep) || c.ep.paper.view.center; // 화면 중심을 옮겨도 십자는 처음 중심
    const bounds = c.layer.bounds;
    if (![viewCenter.x, viewCenter.y, bounds.left, bounds.top,
      bounds.right, bounds.bottom].every(Number.isFinite)) return;
    const previous = pivotUI;
    const fixedPoint = previous?.ep === c.ep ? copy(previous.point) :
      { x: viewCenter.x, y: viewCenter.y };
    if (pivotUI && (pivotUI.picture.id !== c.picture.id ||
        pivotUI.object !== c.object || pivotUI.layer !== c.layer)) {
      const old = pivotUI;
      if (old.object === c.object && !hasNativeCanvas(c.object) && !canvasBox(old) &&
          !old.pictureIds.has(c.picture.id)) {
        const offset = validPivot(old.picture.dimension.entryVectorPivot) ?
          copy(old.picture.dimension.entryVectorPivot) :
          { dx: clean(old.point.x - old.layer.bounds.center.x),
            dy: clean(old.point.y - old.layer.bounds.center.y) };
        old.picture.dimension.entryVectorPivot = copy(old.initialPivot);
        rememberPivot(c.object, old.picture, old.initialPivot);
        c.picture.dimension.entryVectorPivot = offset;
        rememberPivot(c.object, c.picture, offset);
        c.object.entity.setRegX(c.object.entity.getWidth() / 2 + offset.dx);
        c.object.entity.setRegY(c.object.entity.getHeight() / 2 + offset.dy);
        c.E.stage.updateObject();
      }
      old.overlay.remove(); old.costumeOnion.remove(); pivotUI = null;
    }
    const box = canvasBox(c);
    if (box) {
      box.locked = true;
      if (!c.p.file.modified &&
          (!c.picture.dimension.entryVectorNativeCanvas ||
           validPivot(c.picture.dimension.entryVectorPivot))) {
        c.picture.dimension.entryVectorNativeCanvas = true;
        delete c.picture.dimension.entryVectorPivot;
        pivotRecords.get(c.object)?.delete(c.picture.id);
        c.object.entity.setRegX(c.object.entity.getWidth() / 2);
        c.object.entity.setRegY(c.object.entity.getHeight() / 2);
        c.E.stage.updateObject();
      }
    }
    const art = artItems(c)[0];
    const savedPosition = art?.data?.entryVectorCanvasPosition;
    const savedPivot = art?.data?.entryVectorPivotOffset;
    if (!box && !hasNativeCanvas(c.object) && validPivot(savedPivot) &&
        !validPivot(c.picture.dimension.entryVectorPivot)) {
      c.picture.dimension.entryVectorPivot = copy(savedPivot);
      rememberPivot(c.object, c.picture, savedPivot);
      c.object.entity.setRegX(c.object.entity.getWidth() / 2 + savedPivot.dx);
      c.object.entity.setRegY(c.object.entity.getHeight() / 2 + savedPivot.dy);
      c.E.stage.updateObject();
    }
    const restored = restoredLayers.get(c.layer);
    if (!box && validCanvasPosition(savedPosition) &&
        (restored?.pictureId !== c.picture.id || restored.art !== art ||
          !restored.done)) {
      const center = c.layer.bounds.center;
      const delta = new c.ep.paper.Point(savedPosition.x - center.x,
        savedPosition.y - center.y);
      if (delta.length > 0.01)
        c.layer.children.forEach(item => item.translate(delta));
    }
    restoredLayers.set(c.layer, { pictureId: c.picture.id, art,
      done: validCanvasPosition(savedPosition) });
    if (!pivotUI) {
      const entity = c.object.entity;
      const nativePivot = { dx: entity.getRegX() - entity.getWidth() / 2,
        dy: entity.getRegY() - entity.getHeight() / 2 };
      const pivot = validPivot(c.picture.dimension.entryVectorPivot) ?
        c.picture.dimension.entryVectorPivot : nativePivot;
      const overlay = svg('svg', { class: 'evr-pivot-overlay',
        'aria-label': '그림 중심' });
      const costumeOnion = svg('svg', { class: 'evr-costume-onion-overlay',
        'aria-label': '이전·다음 모양 미리보기' });
      const marker = svg('g', { class: 'evr-center-cross',
        'aria-label': '고정 중심점' });
      marker.append(svg('line', { x1: -12, y1: 0, x2: 12, y2: 0 }),
        svg('line', { x1: 0, y1: -12, x2: 0, y2: 12 }),
        svg('circle', { r: 5 }));
      const title = svg('title'); title.textContent =
        '고정 중심점 · 그림을 움직여 십자에 맞추세요';
      marker.append(title);
      overlay.append(svg('rect', { class: 'evr-center-move-surface',
        x: 0, y: 0, width: '100%', height: '100%' }),
      marker);
      c.root.querySelector('.canvas_area').append(costumeOnion, overlay);
      lastCross = { ep: c.ep, point: copy(fixedPoint) };
      pivotUI = { ...c, overlay, marker, costumeOnion,
        pictureIds: new Set(c.object.pictures.map(p => p.id)),
        initialPivot: copy(pivot),
        point: fixedPoint,
        adjusting: c.root.querySelector('.evr-center-mode')?.getAttribute('aria-pressed') === 'true',
        lastArtCenter: { x: c.layer.bounds.center.x,
          y: c.layer.bounds.center.y }, dragging: null };
      overlay.dataset.adjusting = String(pivotUI.adjusting);
      overlay.addEventListener('pointerdown', event => {
        if (!pivotUI?.adjusting || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        overlay.setPointerCapture(event.pointerId);
        pivotUI.dragging = { id: event.pointerId,
          point: pointer(pivotUI, event) };
      });
      overlay.addEventListener('pointermove', event => {
        const p = pivotUI;
        if (!p?.dragging || p.dragging.id !== event.pointerId) return;
        const now = pointer(p, event);
        const delta = { x: now.x - p.dragging.point.x,
          y: now.y - p.dragging.point.y };
        p.dragging.point = now;
        if (Math.hypot(delta.x, delta.y) < 0.001) return;
        // 비트맵은 이전 중심 오프셋 경로(writePivot의 legacy 분기)를 쓰지 않도록 상자를 먼저 만든다.
        if (bitmapMode(p) && !canvasBox(p)) ensureCanvasBox(p);
        // 비트맵(픽셀 모양 포함)은 픽셀 격자 한 칸 단위로만 움직인다. 남은 끌기 거리는 다음 이동에 더한다.
        let step = delta;
        if (bitmapMode(p)) {
          const grid = editorScale(p), rest = p.dragging.rest ||= { x: 0, y: 0 };
          rest.x += delta.x; rest.y += delta.y;
          step = { x: Math.trunc(rest.x / grid) * grid, y: Math.trunc(rest.y / grid) * grid };
          rest.x -= step.x; rest.y -= step.y;
          if (!step.x && !step.y) return;
        }
        const move = new p.ep.paper.Point(step.x, step.y);
        movableItems(p).forEach(item => item.translate(move));
        const box = canvasBox(p);
        const bounds = box && movableBounds(p);
        if (bounds) {
          const old = box.bounds;
          const limit = stageHalf(p, p.point);
          const halfWidth = Math.min(limit.x, Math.ceil(Math.max(old.width / 2,
            Math.abs(bounds.left - p.point.x) + 8,
            Math.abs(bounds.right - p.point.x) + 8)));
          const halfHeight = Math.min(limit.y, Math.ceil(Math.max(old.height / 2,
            Math.abs(bounds.top - p.point.y) + 8,
            Math.abs(bounds.bottom - p.point.y) + 8)));
          box.bounds = new p.ep.paper.Rectangle(p.point.x - halfWidth,
            p.point.y - halfHeight, halfWidth * 2, halfHeight * 2);
        }
        p.lastArtCenter = { x: p.layer.bounds.center.x,
          y: p.layer.bounds.center.y };
        writePivot(p, p.point, {
          dx: p.point.x - p.layer.bounds.center.x,
          dy: p.point.y - p.layer.bounds.center.y,
        });
      });
      const stopDrag = event => {
        if (pivotUI?.dragging?.id === event.pointerId) pivotUI.dragging = null;
      };
      overlay.addEventListener('pointerup', stopDrag);
      overlay.addEventListener('pointercancel', stopDrag);
    }
    drawPivotUI();
  }
  // ---- 뼈대 모드 화면 ----
  // "비트맵 | 벡터" 옆 "뼈대" 버튼으로 켠다. 레이어를 고르고(그림 클릭 또는 오른쪽 목록) Spine처럼 두 단계로 다룬다.
  // - 뼈 만들기: 화면을 흐리게 덮고 고른 레이어의 휘기 전 모양을 그 위에 그린다(실제 그림·저장은 그대로 지금 자세).
  //   그림 위에서 끌면 첫 뼈(누른 곳이 뿌리), 고른 관절의 ＋를 끌면 이어지는 뼈, 관절 끌기 = 위치 옮기기, Delete = 지우기.
  //   모두 휘기 전 좌표에서 하므로 휜 모양이 새 기준으로 굳지 않는다(예전에는 관절을 고치면 그때 모양으로 굳었다).
  // - 자세 잡기: 관절이나 뼈를 끌면 그 뼈가 부모 관절 둘레로 돈다. Shift를 누르고 있거나 IK 단추를 켜면 두 관절 IK.
  //   빈 곳을 눌러도 아무것도 생기지 않는다.
  // 고정된 모드는 지금 모드를 잊어 생기는 오류가 많으므로(Sellen·Kurtenbach·Buxton 1992) 단계를 단추·덮개·안내로 늘 보인다.
  const LAYER_COLORS = ['#4f80ff', '#ff6b4a', '#18a957', '#b05cff', '#f2a900', '#00a3c4',
    '#e0447a', '#7a8b00', '#8a5a2b', '#5b6bff'];
  const layerColor = (s, item) =>
    LAYER_COLORS[Math.max(0, s.layers.indexOf(item)) % LAYER_COLORS.length];
  function hintFor(s) {
    const rig = s.rigs.get(s.current);
    if (!s.current) return '휠 레이어를 그림에서 누르거나 오른쪽 목록에서 고르세요';
    if (s.stage === 'setup') return rig
      ? '＋ 끌기: 새 뼈 · 관절 끌기: 옮기기 · Delete: 지우기'
      : '그림 위에서 끌어 첫 뼈 그리기(누른 곳이 뿌리)';
    if (!rig || rig.joints.length < 2) return '먼저 [뼈 만들기]에서 뼈를 그리세요';
    return '끌기: 뼈 돌리기 · 뿌리(흰 고리) 끌기: 통째로 옮기기 · Shift 끌기 또는 IK: 두 관절';
  }
  function setStage(s, stage) {
    if (s.stage === stage) return;
    s.stage = stage;
    s.dragging = null;
    s.hover = null;
    refreshRigUI(s); draw(s); status(s, hintFor(s));
  }
  function selectLayer(s, item) {
    s.current = item;
    const rig = s.rigs.get(item);
    s.selectedJoint = rig ? rig.joints.length - 1 : -1;
    refreshRigUI(s); draw(s); status(s, hintFor(s));
  }
  function commit(s, item, message) {
    persist(s, item);
    checkpoint(s); refreshRigUI(s); draw(s);
    status(s, message || hintFor(s));
  }
  // 뼈 만들기: 관절 from에서 end까지 뼈 하나(뼈대가 없으면 start를 뿌리로). 휘기 전 좌표라 찍은 자리가 곧 기준 자리다.
  function createBone(s, from, start, end) {
    const item = s.current;
    touch(s, item);
    let rig = s.rigs.get(item);
    if (!rig) {
      rig = { joints: [{ id: 0, parent: -1, x: clean(start.x), y: clean(start.y) }], pose: {},
        source: pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf)), radius: radiusOf(item), sig: shapeSig(item) };
      s.rigs.set(item, rig);
      from = 0;
    }
    if (!rig.joints[from]) return;
    const id = rig.joints.length;
    rig.joints.push({ id, parent: from, x: clean(end.x), y: clean(end.y) });
    s.selectedJoint = id;
    setupChanged(s, item, id === 1 ? '첫 뼈를 그렸습니다 · 끝 관절의 ＋를 끌어 이어 그리세요' : '뼈를 더했습니다');
  }
  // 만들기 단계에서 뼈를 바꾸면 그 레이어는 바뀐 뼈로 지금 자세를 다시 휜다(실제 그림은 늘 지금 자세).
  function setupChanged(s, item, message) {
    if (s.rigs.has(item)) deformLayer(s, item);
    commit(s, item, message);
  }
  function deleteJoint(s, jointId) {
    const item = s.current, rig = s.rigs.get(item);
    if (!rig?.joints[jointId]) return;
    touch(s, item);
    const oldParent = rig.joints[jointId].parent;
    const removed = new Set(rig.joints.filter(joint => {
      for (let cursor = joint.id; cursor >= 0; cursor = rig.joints[cursor].parent)
        if (cursor === jointId) return true;
      return false;
    }).map(joint => joint.id));
    const keep = rig.joints.filter(joint => !removed.has(joint.id));
    const map = new Map(keep.map((joint, index) => [joint.id, index]));
    s.cache.delete(item);
    if (keep.length) {
      rig.joints = keep.map((joint, index) => ({ ...joint, id: index,
        parent: joint.parent < 0 ? -1 : map.get(joint.parent) }));
      // 남은 뼈의 각도는 그대로 둔다(번호만 바뀜). 뿌리를 옮긴 거리는 뼈가 남아 있을 때만 둔다(뼈가 없으면 휘지 않음).
      const rootMove = key => key === 'rootX' || key === 'rootY';
      rig.pose = Object.fromEntries(Object.entries(rig.pose)
        .filter(([id]) => rootMove(id) ? keep.length > 1 : map.has(Number(id)))
        .map(([id, angle]) => [rootMove(id) ? id : map.get(Number(id)), angle]));
      s.selectedJoint = map.has(oldParent) ? map.get(oldParent) : rig.joints.length - 1;
      setupChanged(s, item, '관절을 지웠습니다');
    } else {
      // 뼈대를 모두 지우면 휘기 전 모양으로 돌아간다.
      const leaves = pathItems(item);
      if (leaves.length === rig.source.length) leaves.forEach((leaf, i) => setWorldPathData(s.ep.paper, leaf, rig.source[i]));
      s.rigs.delete(item);
      s.selectedJoint = -1;
      commit(s, item, '이 레이어의 뼈대를 모두 지웠습니다');
    }
  }
  function resetPose(s) {
    const item = s.current, rig = s.rigs.get(item);
    if (!rig || !posed(rig)) return;
    touch(s, item);
    rig.pose = {};
    deformLayer(s, item);
    commit(s, item, '휘기 전 모양으로 되돌렸습니다');
  }
  // 끄는 각도는 지난 각도에 가장 가까운 같은 방향 값으로 고른다. atan2 차이만 쓰면 뼈가 왼쪽을 지나는 순간(±180°) −5° 대신
  // −355°가 되어 굽는 곳이 한 바퀴 감겼다(시험: 왼쪽을 향한 팔 끝을 10px 위로 끌기 → 접힌 점 0 → 132). 이어 붙이므로 계속
  // 돌리면 180°를 넘어서도 끊기지 않고 따라간다.
  const nearestTurn = (angle, previous) => clean(angle + 360 * Math.round(((Number(previous) || 0) - angle) / 360));
  function poseDrag(s, rig, jointId, p, useIK) {
    const joint = rig.joints[jointId], parent = rig.joints[joint.parent];
    const pose = { ...rig.pose }, old = worlds(rig.joints, pose);
    if (!parent) { // 뿌리: 뼈대와 그림을 통째로 옮긴다(각도는 그대로)
      pose.rootX = clean(p.x - joint.x);
      pose.rootY = clean(p.y - joint.y);
    } else if (useIK && parent.parent >= 0 && window.IK?.Chain2D) {
      const grand = rig.joints[parent.parent];
      const a = at(old[grand.id], grand), b = at(old[parent.id], parent), c = at(old[joint.id], joint);
      const chain = new IK.Chain2D();
      chain.addBone(new IK.Bone2D(new IK.V2(a.x, a.y), new IK.V2(b.x, b.y)));
      chain.addBone(new IK.Bone2D(new IK.V2(b.x, b.y), new IK.V2(c.x, c.y)));
      chain.solveForTarget(new IK.V2(p.x, p.y));
      const mid = chain.bones[0].end, end = chain.bones[1].end;
      const localMid = at(inverse(old[grand.id]), mid);
      pose[parent.id] = nearestTurn(degrees(localMid.x - grand.x, localMid.y - grand.y)
        - degrees(parent.x - grand.x, parent.y - grand.y), rig.pose[parent.id]);
      const updated = worlds(rig.joints, pose);
      const localEnd = at(inverse(updated[parent.id]), end);
      pose[joint.id] = nearestTurn(degrees(localEnd.x - parent.x, localEnd.y - parent.y)
        - degrees(joint.x - parent.x, joint.y - parent.y), rig.pose[joint.id]);
    } else {
      const local = at(inverse(old[parent.id]), p);
      pose[joint.id] = nearestTurn(degrees(local.x - parent.x, local.y - parent.y)
        - degrees(joint.x - parent.x, joint.y - parent.y), rig.pose[joint.id]);
    }
    if (!Object.values(pose).every(Number.isFinite)) return;
    rig.pose = pose;
    deformLayer(s, s.current);
    draw(s);
  }
  // 휘기 전 모양의 범위(기준 모양 글이 바뀔 때만 다시 잰다).
  function restBounds(s, item, rig) {
    const key = rig.source.join('\n');
    let cached = s.restBounds.get(item);
    if (cached?.key !== key) {
      let bounds = null;
      for (const data of rig.source) {
        const path = new s.ep.paper.CompoundPath({ pathData: data, insert: false });
        bounds = bounds ? bounds.unite(path.bounds) : path.bounds;
      }
      cached = { key, bounds: bounds || item.bounds };
      s.restBounds.set(item, cached);
    }
    return cached.bounds;
  }
  // 레이어 범위: 만들기 단계에서는 휘기 전 모양, 자세 단계에서는 지금 모양.
  function layerBounds(s, item) {
    const rig = s.stage === 'setup' && s.rigs.get(item);
    return rig ? restBounds(s, item, rig) : item.bounds;
  }
  // 레이어의 화면 사각형.
  function pieceRect(s, item) {
    const b = layerBounds(s, item), a = screen(s, { x: b.left, y: b.top }), z = screen(s, { x: b.right, y: b.bottom });
    return { x: Math.min(a.x, z.x), y: Math.min(a.y, z.y), width: Math.abs(z.x - a.x),
      height: Math.abs(z.y - a.y) };
  }
  // 점 아래 맨 위 레이어(벡터 그림만).
  function layerAt(s, p) {
    const zoom = s.ep.paper.view.zoom || 1;
    const hit = s.layer.hitTest(new s.ep.paper.Point(p.x, p.y),
      { fill: true, stroke: true, tolerance: 4 / zoom });
    for (let node = hit?.item; node; node = node.parent) if (s.layers.includes(node)) return node;
    return null;
  }
  // 고른 레이어 둘레(조금 넓게) 안인가.
  function nearCurrent(s, p) {
    if (!s.current) return false;
    const pad = 12 / (s.ep.paper.view.zoom || 1), b = layerBounds(s, s.current);
    return p.x >= b.left - pad && p.x <= b.right + pad && p.y >= b.top - pad && p.y <= b.bottom + pad;
  }
  // 만들기 단계에서 덮개 위에 그리는 고른 레이어의 휘기 전 모양(제 색). 경로 요소는 기준 모양이 바뀔 때만 새로 만든다.
  function restPreview(s, item) {
    const rig = s.rigs.get(item), data = rig ? rig.source : pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf));
    const key = data.join('\n');
    let cached = s.previews.get(item);
    if (cached?.key !== key) {
      const group = svg('g', { class: 'evr-rig-rest' }), leaves = pathItems(item);
      const css = color => color && color.type !== 'gradient' ? color.toCSS(false) : null;
      data.forEach((d, i) => {
        const leaf = leaves[i], fill = css(leaf?.fillColor), stroke = css(leaf?.strokeColor);
        group.append(svg('path', { d, fill: fill || 'none', 'fill-rule': leaf?.fillRule || 'nonzero',
          stroke: stroke || 'none', 'stroke-width': stroke ? Number(leaf.strokeWidth) || 1 : 0 }));
      });
      cached = { key, group };
      s.previews.set(item, cached);
    }
    const m = s.ep.paper.view.matrix, k = s.canvas.getBoundingClientRect().width / s.ep.paper.view.viewSize.width || 1;
    cached.group.setAttribute('transform', `matrix(${m.a * k} ${m.b * k} ${m.c * k} ${m.d * k} ${m.tx * k} ${m.ty * k})`);
    return cached.group;
  }
  function draw(s) {
    if (!s.overlay || !current(s)) return;
    const canvasBox = s.canvas.getBoundingClientRect();
    const areaBox = s.overlay.parentElement.getBoundingClientRect();
    Object.assign(s.overlay.style, { left: `${canvasBox.left - areaBox.left}px`,
      top: `${canvasBox.top - areaBox.top}px`, width: `${canvasBox.width}px`,
      height: `${canvasBox.height}px` });
    s.overlay.setAttribute('viewBox', `0 0 ${canvasBox.width} ${canvasBox.height}`);
    const setup = s.stage === 'setup';
    s.overlay.dataset.stage = s.stage;
    s.overlay.replaceChildren(svg('rect', { class: 'evr-rig-surface', x: 0, y: 0,
      width: '100%', height: '100%' }));
    // 만들기 단계: 흐린 덮개 + 고른 레이어의 휘기 전 모양
    if (setup) {
      s.overlay.append(svg('rect', { class: 'evr-rig-veil', x: 0, y: 0, width: '100%', height: '100%' }));
      if (s.current) s.overlay.append(restPreview(s, s.current));
    }
    // 고른 레이어는 실선, 누르면 고를 수 있는 레이어(목록에서 가리킨 것 포함)는 점선으로 두른다.
    const outline = (item, kind) => {
      const r = pieceRect(s, item);
      s.overlay.append(svg('rect', { class: 'evr-rig-piece', 'data-kind': kind, x: r.x - 3,
        y: r.y - 3, width: r.width + 6, height: r.height + 6, stroke: layerColor(s, item) }));
    };
    if (s.hover && s.hover !== s.current && s.layers.includes(s.hover)) outline(s.hover, 'hover');
    if (s.current) outline(s.current, 'current');
    const rig = s.rigs.get(s.current), color = s.current ? layerColor(s, s.current) : '#4f80ff';
    if (rig) {
      // 만들기 단계는 휘기 전 관절 자리, 자세 단계는 뼈의 실제 자리(Spine·Blender처럼 뼈를 그리고 그림은 가중치로 따라감)
      const points = (setup ? rig.joints : jointPoints(rig)).map(p => screen(s, p));
      for (const joint of rig.joints) {
        if (joint.parent < 0) continue;
        const a = points[joint.parent], z = points[joint.id];
        s.overlay.append(svg('line', { class: 'evr-rig-bone', x1: a.x, y1: a.y, x2: z.x, y2: z.y, stroke: color }));
        // 자세 단계에서는 뼈 몸통을 끌어도 그 뼈가 돈다(넓은 투명 선으로 잡는다).
        if (!setup) s.overlay.append(svg('line', { class: 'evr-rig-bone-hit', x1: a.x, y1: a.y, x2: z.x, y2: z.y,
          'data-bone': joint.id }));
      }
      for (const joint of rig.joints) {
        const selected = joint.id === s.selectedJoint, root = joint.parent < 0;
        const attrs = { class: 'evr-rig-joint', cx: points[joint.id].x, cy: points[joint.id].y,
          r: selected ? 8 : root ? 7 : 6, fill: root ? '#fff' : color, 'data-joint': joint.id,
          'data-selected': selected, 'data-root': root };
        // 뿌리 관절은 속이 흰 고리로 구분한다.
        if (root) attrs.style = `stroke:${selected ? '#222' : color};stroke-width:3`;
        s.overlay.append(svg('circle', attrs));
      }
      // 만들기 단계: 고른 관절 옆 ＋(끌면 이 관절에서 이어지는 뼈). 이어 붙을 자리를 늘 보여 준다.
      const picked = setup && rig.joints[s.selectedJoint];
      if (picked) {
        const at0 = points[picked.id], from = picked.parent >= 0 ? points[picked.parent] : null;
        let ux = Math.SQRT1_2, uy = -Math.SQRT1_2;
        if (from) { const dx = at0.x - from.x, dy = at0.y - from.y, l = Math.hypot(dx, dy); if (l > 1) { ux = dx / l; uy = dy / l; } }
        const plus = svg('g', { class: 'evr-rig-plus', 'data-plus': picked.id,
          transform: `translate(${at0.x + ux * 24} ${at0.y + uy * 24})` });
        plus.append(svg('circle', { r: 9, fill: color }), svg('path', { d: 'M-4.5 0H4.5M0-4.5V4.5' }));
        s.overlay.append(plus);
      }
    }
    // 뼈를 그리는 중: 시작에서 지금 마우스까지 미리 보기
    const drag = s.dragging;
    if (drag?.kind === 'create' && drag.end) {
      const a = screen(s, drag.start), z = screen(s, drag.end);
      s.overlay.append(svg('line', { class: 'evr-rig-preview', x1: a.x, y1: a.y, x2: z.x, y2: z.y, stroke: color }),
        svg('circle', { class: 'evr-rig-preview-joint', cx: z.x, cy: z.y, r: 6, fill: color }));
      if (drag.from < 0) s.overlay.append(svg('circle', { class: 'evr-rig-preview-joint', cx: a.x, cy: a.y, r: 7,
        fill: '#fff', style: `stroke:${color};stroke-width:3` }));
    }
  }
  // 레이어 목록과 버튼 상태를 지금 데이터에 맞춘다.
  function refreshRigUI(s) {
    if (!s.ui) return;
    s.ui.layers.replaceChildren(...s.layers.map((item, index) => {
      const rig = s.rigs.get(item);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'evr-rig-layer';
      row.dataset.picked = String(item === s.current);
      const swatch = document.createElement('span');
      swatch.className = 'evr-rig-swatch';
      swatch.style.background = layerColor(s, item);
      const name = document.createElement('span');
      name.className = 'evr-rig-name';
      name.textContent = item.name || `레이어 ${index + 1}`;
      const bones = document.createElement('span');
      bones.className = 'evr-rig-bone-label';
      bones.textContent = rig ? `관절 ${rig.joints.length}` : '뼈대 없음';
      row.append(swatch, name, bones);
      row.title = '이 레이어를 골라 뼈를 그리고 휩니다';
      row.addEventListener('mouseenter', () => { s.hover = item; draw(s); });
      row.addEventListener('mouseleave', () => { s.hover = null; draw(s); });
      row.addEventListener('click', () => selectLayer(s, item));
      return row;
    }));
    if (!s.layers.length) s.ui.layers.append(text('p', '벡터 도형이 없습니다'));
    const rig = s.rigs.get(s.current), setup = s.stage === 'setup';
    s.ui.setup.setAttribute('aria-pressed', String(setup));
    s.ui.pose.setAttribute('aria-pressed', String(!setup));
    s.ui.removeJoint.hidden = !setup;
    s.ui.removeJoint.disabled = !rig?.joints[s.selectedJoint];
    s.ui.reset.hidden = setup;
    s.ui.reset.disabled = !(rig && posed(rig));
    s.ui.ik.hidden = setup;
    s.ui.ik.setAttribute('aria-pressed', String(!!s.ik));
    refreshHistoryButtons(s);
  }
  function overlayEvents(s) {
    const begin = (event, drag) => {
      s.overlay.setPointerCapture?.(event.pointerId);
      s.dragging = { pointerId: event.pointerId, item: s.current, x: event.clientX, y: event.clientY, ...drag };
    };
    // 관절을 잡은 자리 → 관절 중심 차이(만들기 단계는 휘기 전 자리, 자세 단계는 지금 자리 기준)
    const grabOffset = (rig, id, p, setup) => {
      const joint = setup ? rig.joints[id] : jointPoints(rig)[id];
      return { x: joint.x - p.x, y: joint.y - p.y };
    };
    s.overlay.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !current(s)) return;
      event.preventDefault();
      const p = pointer(s, event), setup = s.stage === 'setup', rig = s.rigs.get(s.current);
      const plus = event.target.closest?.('[data-plus]'), jointHit = event.target.closest?.('[data-joint]');
      const boneHit = event.target.closest?.('[data-bone]');
      try {
        if (plus && setup && rig?.joints[Number(plus.dataset.plus)]) {
          const from = Number(plus.dataset.plus);
          begin(event, { kind: 'create', from, start: { x: rig.joints[from].x, y: rig.joints[from].y }, end: null });
          return;
        }
        if (jointHit && rig?.joints[Number(jointHit.dataset.joint)]) {
          const id = Number(jointHit.dataset.joint);
          s.selectedJoint = id;
          touch(s, s.current);
          if (setup) begin(event, { kind: 'move', joint: id, offset: grabOffset(rig, id, p, true) });
          else begin(event, { kind: 'pose', joint: id, ik: true, offset: grabOffset(rig, id, p, false) });
          refreshRigUI(s); draw(s);
          return;
        }
        if (boneHit && !setup && rig?.joints[Number(boneHit.dataset.bone)]) {
          const id = Number(boneHit.dataset.bone);
          s.selectedJoint = id;
          touch(s, s.current);
          begin(event, { kind: 'pose', joint: id, ik: false });
          refreshRigUI(s); draw(s);
          return;
        }
        if (setup && s.current && !rig && nearCurrent(s, p)) {
          begin(event, { kind: 'create', from: -1, start: p, end: null });
          return;
        }
        const other = layerAt(s, p);
        if (other && other !== s.current) return selectLayer(s, other);
        status(s, hintFor(s));
      } catch (error) { status(s, error.message || String(error)); }
    });
    s.overlay.addEventListener('pointermove', event => {
      const drag = s.dragging;
      if (!drag) {
        if (!current(s)) return;
        const p = pointer(s, event), other = nearCurrent(s, p) ? null : layerAt(s, p);
        const hover = other && other !== s.current ? other : null;
        if (hover !== s.hover) {
          s.hover = hover;
          s.overlay.dataset.cursor = hover ? 'pick' : '';
          draw(s);
        }
        return;
      }
      if (drag.pointerId !== event.pointerId) return;
      try { follow(drag, event); } catch (error) { status(s, error.message); s.dragging = null; }
    });
    // 끄는 중 마우스 자리를 반영한다. 3px 넘게 움직여야 끌기로 치고(관절을 누르기만 하면 그대로), 관절은 잡은 자리와
    // 관절 중심의 차이를 유지해 잡는 순간 튀지 않는다.
    const follow = (drag, event) => {
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        drag.started = true;
      }
      const rig = s.rigs.get(drag.item), raw = pointer(s, event);
      const p = drag.offset ? { x: raw.x + drag.offset.x, y: raw.y + drag.offset.y } : raw;
      if (drag.item !== s.current) return;
      if (drag.kind === 'create') { drag.end = p; draw(s); return; }
      if (!rig || !rig.joints[drag.joint]) return;
      if (drag.kind === 'move') {
        rig.joints[drag.joint].x = clean(p.x);
        rig.joints[drag.joint].y = clean(p.y);
        draw(s);
      } else poseDrag(s, rig, drag.joint, p, drag.ik && (event.shiftKey || s.ik));
      drag.moved = true;
    };
    // 놓으면: 놓은 자리도 한 번 반영하고(마지막 이동 뒤에 조금 더 움직였을 수 있음), 뼈 그리기는 6px 넘게 끌었을 때만
    // 뼈를 만들고, 관절 옮기기·휘기는 바뀐 것을 기록한다.
    const stop = event => {
      const drag = s.dragging;
      s.dragging = null;
      if (!drag) return;
      try {
        if (event.type === 'pointerup' && drag.pointerId === event.pointerId) follow(drag, event);
        if (drag.kind === 'create') {
          const a = screen(s, drag.start), z = drag.end && screen(s, drag.end);
          if (event.type === 'pointerup' && z && drag.item === s.current && Math.hypot(z.x - a.x, z.y - a.y) >= 6)
            return createBone(s, drag.from, drag.start, drag.end);
          draw(s);
          status(s, drag.from < 0 ? '누른 채 끌어서 첫 뼈를 그리세요' : '＋를 누른 채 끌어서 새 뼈를 그리세요');
        } else if (drag.kind === 'move' && drag.moved) setupChanged(s, drag.item, '관절을 옮겼습니다');
        else if (drag.moved) commit(s, drag.item, '');
      } catch (error) { status(s, error.message || String(error)); }
    };
    s.overlay.addEventListener('pointerup', stop);
    s.overlay.addEventListener('pointercancel', stop);
    s.overlay.addEventListener('pointerleave', () => {
      if (s.dragging || !s.hover) return;
      s.hover = null;
      s.overlay.dataset.cursor = '';
      draw(s);
    });
  }

  function button(label, action, attrs = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    for (const [key, value] of Object.entries(attrs)) b.setAttribute(key, value);
    b.addEventListener('click', () => {
      try { action(); } catch (error) {
        if (session) status(session, error.message || String(error));
        else window.alert(error.message || String(error));
      }
    });
    return b;
  }
  // 오래 걸리는 버튼 작업: 끝날 때까지 다시 누를 수 없고, 실패하면 이유를 알려 준다.
  function runButton(target, task) {
    if (target.disabled) return;
    target.disabled = true;
    Promise.resolve().then(task)
      .catch(error => window.alert(error?.message || String(error)))
      .finally(() => { target.disabled = false; });
  }
  function text(tag, value) {
    const el = document.createElement(tag); el.textContent = value; return el;
  }
  function buildRigUI(s) {
    const area = s.root.querySelector('.canvas_area');
    const top = document.createElement('div'); top.className = 'evr-rig-top';
    const undo = button('↶', () => historyStep(s, -1), { title: '되돌리기 (Ctrl+Z)' });
    const redo = button('↷', () => historyStep(s, 1), { title: '다시하기 (Ctrl+Shift+Z)' });
    // 지금 단계를 늘 보이게 하는 두 칸 단추
    const stages = document.createElement('div'); stages.className = 'evr-rig-stage';
    const setup = button('뼈 만들기', () => setStage(s, 'setup'),
      { title: '뼈를 그리고 관절 자리를 고칩니다 (휘기 전 모양으로 보임)' });
    const pose = button('자세 잡기', () => setStage(s, 'pose'), { title: '관절이나 뼈를 끌어 그림을 휩니다' });
    stages.append(setup, pose);
    const removeJoint = button('관절 지우기', () => deleteJoint(s, s.selectedJoint),
      { title: '고른 관절과 그 아래 관절을 지웁니다 (Delete)' });
    const reset = button('자세 초기화', () => resetPose(s),
      { title: '이 레이어를 휘기 전 모양으로 되돌립니다' });
    const ik = button('IK', () => {
      s.ik = !s.ik;
      refreshRigUI(s);
      status(s, s.ik ? 'IK 켬: 끝 관절을 끌면 위 관절도 같이 움직입니다' : hintFor(s));
    }, { title: '두 관절 IK: 끝 관절을 끌면 위 관절도 같이 움직입니다 (Shift를 누르고 끌어도 됨)' });
    const hint = document.createElement('span'); hint.className = 'evr-rig-hint';
    top.append(undo, redo, stages, removeJoint, reset, ik, hint);
    const side = document.createElement('div'); side.className = 'evr-rig-layers-box';
    const layers = document.createElement('div'); layers.className = 'evr-rig-layers';
    // 목록이 그림을 가리면 제목을 눌러 접는다. 다시 열어도 접힌 채로 둔다.
    const fold = button('', () => {
      layersFolded = !layersFolded;
      side.dataset.folded = String(layersFolded);
      fold.textContent = `레이어 ${layersFolded ? '▸' : '▾'}`;
    }, { class: 'evr-rig-layers-head', title: '레이어 목록 접기 / 펴기' });
    side.dataset.folded = String(layersFolded);
    fold.textContent = `레이어 ${layersFolded ? '▸' : '▾'}`;
    side.append(fold, layers);
    const overlay = svg('svg', { class: 'evr-overlay', 'aria-label': '뼈대 캔버스' });
    area.append(overlay, top, side);
    // 엔트리 선택 도구는 문서(document)에서 받은 마우스 이동으로 마우스 밑 도형에 윤곽선을 그린다(entry-paint 선택 도구
    // move → activateItem; paper.js는 mousemove·touchmove를 document에서 받는다). 뼈대 덮개 위에서도 그래서 관절을 끄는
    // 동안 휜 도형 위에 휘기 전 윤곽선이 남았다(실제 엔트리: 관절 위로 마우스를 옮기자 윤곽선 1개, 놓은 뒤에도 남음).
    // 뼈대 화면 안에서 생긴 마우스 이동은 엔트리로 보내지 않는다(덮개·위 막대·레이어 목록은 닫을 때 함께 없어진다).
    for (const node of [overlay, top, side])
      for (const type of ['mousemove', 'touchmove']) node.addEventListener(type, event => event.stopPropagation());
    s.overlay = overlay;
    s.ui = { top, side, undo, redo, setup, pose, removeJoint, reset, ik, hint, layers };
    overlayEvents(s);
    refreshRigUI(s); draw(s);
    status(s, hintFor(s));
    s.onKey = event => {
      if (!session || session !== s ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
        event.preventDefault(); event.stopImmediatePropagation();
        historyStep(s, key === 'y' || event.shiftKey ? 1 : -1);
      } else if (key === 'delete' || key === 'backspace') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (s.stage !== 'setup') return status(s, '관절 지우기는 [뼈 만들기]에서 합니다');
        try { deleteJoint(s, s.selectedJoint); } catch (error) { status(s, error.message || String(error)); }
      } else if (key === 'escape' && s.current) {
        selectLayer(s, null);
      }
    };
    document.addEventListener('keydown', s.onKey, true);
  }

  function close() {
    const s = session;
    if (!s) return;
    session = null;
    s.overlay?.remove();
    s.ui?.top.remove(); s.ui?.side.remove();
    document.removeEventListener('keydown', s.onKey, true);
    s.opener?.setAttribute('aria-pressed', 'false');
  }
  // 엔트리 선택 도구는 고른 도형마다 복제한 윤곽선과 변형 상자·손잡이를 guide 레이어에 그려 두고, 도형이 바뀌어도 다시
  // 그리지 않는다(entry-paint Nn.activateItem: clone + 그때의 globalMatrix). 모양을 열면 엔트리가 그림 전체를 골라 두므로,
  // 뼈대가 도형을 휘거나 옮기면 옛 윤곽선이 그 자리에 남았다(사용자 화면; 실제 엔트리에서 도형을 80px 옮겨도 윤곽선은
  // 그대로임을 확인). 그래서 뼈대 모드를 열 때 선택을 푼다. 엔트리 공개 메서드 getPaperJSON은 내보내기 전에 선택을 비우는
  // 액션(selectedItems = [])을 먼저 보내고, 선택 도구가 이를 받아 윤곽선·상자·손잡이를 지운다(실제 엔트리: guide 51개 → 0,
  // 수정됨 표시 그대로, 5ms). 실패해도 뼈대 모드는 연다(옛 윤곽선이 남는 것뿐).
  function clearEntrySelection(c) {
    if (!c.layer.getItems({ match: item => item.data?.selected || item.data?.guideItem }).length) return;
    try { c.ep.getPaperJSON(); } catch (error) { console.warn('[entry-vector-rig] 엔트리 선택 풀기 실패', error); }
  }
  function open(c, opener) {
    if (session) close();
    if (bitmapMode(c)) throw Error('뼈대 모드는 벡터 모양에서 쓸 수 있습니다.');
    if (!c.layer.children.length) throw Error('벡터 모양이 비어 있습니다.');
    clearEntrySelection(c);
    refreshPivotUI(c);
    session = makeSession(c, opener);
    buildRigUI(session);
    opener?.setAttribute('aria-pressed', 'true');
  }
  // "비트맵 | 벡터" 전환 묶음 옆 "뼈대" 버튼. 다른 확장이 같은 자리에 버튼을 넣어도 몇 번째인지에
  // 기대지 않는다: 엔트리(React)가 그리는 묶음(.modeSpace) 안에는 넣지 않고 뒤에 붙이며,
  // 우리 버튼은 data-evr-mode 표식으로만 찾는다. 남의 버튼은 건드리지 않는다.
  function ensureRigModeButton(c) {
    const space = c?.root.querySelector('.modeSpace');
    let wrap = document.querySelector('.evr-mode-wrap[data-evr-mode="bone"]');
    if (!space) { wrap?.remove(); if (session) close(); return; }
    let mode = wrap?.querySelector('.evr-bone-mode');
    if (!mode) {
      wrap?.remove();
      wrap = document.createElement('div');
      wrap.className = 'evr-mode-wrap';
      wrap.dataset.evrMode = 'bone';
      mode = document.createElement('button');
      mode.type = 'button';
      mode.className = 'evr-bone-mode';
      mode.title = '뼈대 모드';
      mode.setAttribute('aria-label', '뼈대'); // 자리가 모자라 글자를 숨겨도(fitTools) 이름이 남게
      mode.setAttribute('aria-pressed', 'false');
      mode.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
        '<circle cx="3" cy="13" r="2"/><circle cx="8" cy="7" r="2"/><circle cx="13" cy="3" r="2"/>' +
        '<path d="M4.3 11.6 6.7 8.4M9.4 5.7l2.2-1.6" stroke-width="1.6" fill="none"/></svg>' +
        '<span>뼈대</span>';
      mode.addEventListener('click', () => {
        try {
          if (session) close();
          else open(context(), mode);
        } catch (error) { window.alert(error.message || String(error)); }
      });
      wrap.append(mode);
    }
    // 묶음 뒤 같은 줄에 있으면 그대로 둔다. "바로 뒤" 자리를 고집하면 같은 방식을 쓰는 다른 확장과
    // 서로 계속 자리를 바꾸게 된다. 바로 뒤일 때만 세 번째 칸처럼 붙어 보인다(CSS).
    if (wrap.parentElement !== space.parentElement ||
        !(space.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING)) space.after(wrap);
    const disabled = bitmapMode(c) || !c.layer.children.length;
    if (mode.disabled !== disabled) mode.disabled = disabled;
    mode.title = disabled ? '벡터 모양에서 쓸 수 있습니다' :
      '뼈대 모드: [뼈 만들기]에서 뼈를 그리고 [자세 잡기]에서 끌어 벡터 그림을 휩니다';
    mode.setAttribute('aria-pressed', String(!!session));
  }
  // ---- 모양 편집기 화면 이동·확대 (스프라이트 나누기 미리보기와 같은 조작) ----
  // 엔트리 편집기(entry-paint)는 2400×1350 캔버스를 담은 상자(PaperCanvas)의 left/top을 옮겨 화면을 움직이고
  // (손 도구, 범위 -(캔버스-칸+10)~10px), 확대는 캔버스 가운데를 기준으로 paper view.zoom을 바꾼다(−/100%/+ 버튼
  // 30~250%, CHANGE_ZOOM으로 선택 손잡이 크기를 맞춤). 이 방식을 그대로 지키면서
  // - 휠: 커서 아래 점을 기준으로 한 단계씩 확대·축소(단계는 스프라이트 나누기와 같음, 25~1600%)
  // - 스페이스·가운데·오른쪽 버튼 + 끌기: 화면 이동(손 도구 범위를 넘으면 아래처럼 화면 중심으로 이어 감).
  //   250%를 넘기면 엔트리 이동 도구의 왼쪽 끌기도 같은 이동으로 받는다(entryHandTool).
  // - 엔트리 −/100%/+ 버튼도 같은 단계로(100%는 가운데로 되돌림)
  // 그림판 상자는 손 도구 범위까지만 움직이므로, 250%를 넘겨 무대(960×540)가 그림판보다 커지면 그 너머는 화면 중심을
  // 옮겨 이어 간다. 엔트리는 view.center를 "처음 중심(home) = 무대 가운데"로 쓴다(불러온 모양 그림을 거기 놓고, 글상자
  // 입력칸 위치를 그 기준으로 계산). 그래서 이 보기의 center 속성은 늘 home을 돌려주게 하고(pinViewCenter), 확장은 실제
  // 중심을 getCenter/setCenter로만 다룬다(paper 내부도 getCenter를 씀). 글상자 입력칸과 아래쪽 좌표 표시는 옮긴 만큼 보정한다.
  const PAINTER_ZOOM = { min: .25, max: 16 };
  // 엔트리 자체 최대 배율(+ 버튼 250%). 이때 캔버스(2400×1350)가 무대(960×540)를 꼭 덮는다. 엔트리는 이보다 큰 배율을
  // 예상하지 않으므로(이동 도구 범위, 비트맵 보간 표시 등), 확장은 이 배율을 넘을 때만 따로 다룬다. 이하에서는 순정과 같다.
  const ENTRY_ZOOM_MAX = 2.5;
  // 처음 화면 중심(home)과 무대 사각형. 엔트리는 처음에 무대 레이어를 화면 중심에 놓으므로 무대 가운데가 곧 home이다.
  // 끄는 동안 레이어를 다시 훑지 않게 편집기마다 한 번만 잰다. 무대를 못 찾으면 중심은 옮기지 않는다(상자만).
  const painterHomes = new WeakMap();
  function painterHome(ep) {
    if (painterHomes.has(ep)) return painterHomes.get(ep);
    const stage = ep?.project?.view && paintLayer(ep)?.stage;
    if (!stage) return null;
    const found = { home: { x: (stage.left + stage.right) / 2, y: (stage.top + stage.bottom) / 2 },
      stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom } };
    painterHomes.set(ep, found);
    return found;
  }
  const homeCenter = ep => painterHome(ep)?.home || null;
  let painterSpace = false, painterHover = false, viewFrame = 0;
  function painterParts(painter) {
    const view = painter?.entryPaint?.project?.view, canvas = view?.element;
    const box = canvas?.parentElement, area = canvas?.closest?.('.canvas_area');
    if (!box || !area) return null;
    const ep = painter.entryPaint, found = painterHome(ep);
    return { view, canvas, box, area, ep, paper: ep.paper, home: found?.home || null, stage: found?.stage || null };
  }
  const painterBoxAt = ({ box }) => ({ left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 });
  // 지금 화면 이동량(화면 px) = 그림판 상자 위치 + 실제 중심이 home에서 벗어난 만큼 × 배율
  function painterPan(parts) {
    const { left, top } = painterBoxAt(parts), { view, home } = parts, zoom = view.zoom;
    if (!home) return { x: left, y: top };
    const center = view.getCenter();
    return { x: left + (home.x - center.x) * zoom, y: top + (home.y - center.y) * zoom };
  }
  // 이동량을 나눠 싣는다: 그림판 상자가 엔트리 손 도구 범위(정수 px, 엔트리가 parseInt로 읽음)까지 먼저, 넘치는 만큼은
  // 화면 중심을 반대로 옮긴다. 중심은 캔버스가 무대 가장자리까지 덮을 만큼만 옮긴다 — 엔트리 250%(캔버스 = 무대)에서처럼
  // 무대 가장자리가 칸 끝(+10px)에 닿을 때까지. 250% 이하는 캔버스가 이미 무대를 덮으므로 중심은 home 그대로(순정과 같음).
  // 되돌아오면 중심부터 home으로 돌아온다.
  function setPainterPan(parts, x, y) {
    const { canvas, box, area, view, home, stage, paper } = parts, zoom = view.zoom, areaBox = area.getBoundingClientRect();
    const left = Math.round(clampTo(x, -(canvas.offsetWidth - areaBox.width + 10), 10));
    const top = Math.round(clampTo(y, -(canvas.offsetHeight - areaBox.height + 10), 10));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    if (!home) return;
    // 캔버스가 덮는 그림 범위 = 중심 ± 캔버스 반폭/배율
    const halfW = canvas.offsetWidth / 2 / zoom, halfH = canvas.offsetHeight / 2 / zoom;
    const cx = clampTo(home.x - (x - left) / zoom, Math.min(home.x, stage.left + halfW), Math.max(home.x, stage.right - halfW));
    const cy = clampTo(home.y - (y - top) / zoom, Math.min(home.y, stage.top + halfH), Math.max(home.y, stage.bottom - halfH));
    const center = view.getCenter();
    if (Math.abs(cx - center.x) > 1e-6 || Math.abs(cy - center.y) > 1e-6) view.setCenter(new paper.Point(cx, cy));
  }
  function movePainterBox(parts, dx, dy) {
    const pan = painterPan(parts);
    setPainterPan(parts, pan.x + dx, pan.y + dy);
  }
  // 엔트리 쪽 view.center는 늘 home. 엔트리가 이 값을 읽는 곳(entry-paint 260921): 무대·배경 레이어 처음 배치, 모양
  // 그림 불러오기(SVG lC, Raster onLoad — 모양 바꾸기와 pictureImport 두 길 모두), 글상자 입력칸 위치 식. paper 내부(확대
  // setZoom 등)는 getCenter()를 쓰므로 실제 중심 그대로 움직인다.
  function pinViewCenter(parts) {
    const { view, home, paper } = parts;
    if (!home || own(view, 'center')) return;
    Object.defineProperty(view, 'center', { configurable: true,
      get: () => new paper.Point(home.x, home.y),
      set: value => view.setCenter(value) });
  }
  // 전체화면 전환 때 엔트리가 부르는 realign(그림판 상자를 가운데로)은 중심도 처음 자리로 되돌린다.
  function pinRealign(parts) {
    const { ep, view, home, paper } = parts;
    if (!home || typeof ep.realign !== 'function' || own(ep, 'realign')) return;
    const original = ep.realign;
    ep.realign = function (...args) {
      const result = original.apply(this, args);
      view.setCenter(new paper.Point(home.x, home.y));
      afterPainterView();
      return result;
    };
  }
  // 아래쪽 마우스 좌표 표시: 엔트리는 (offsetX - (캔버스 폭 - 무대 폭×배율)/2)/배율로, 중심이 home이라고 보고 잰다.
  // 중심을 옮긴 만큼(화면 px)을 offset에 더해 넘긴다(엔트리 처리는 offsetX·offsetY만 읽는다).
  function fixMouseReadout(parts) {
    const { box } = parts;
    if (box.__evrReadout || typeof box.onmousemove !== 'function') return;
    const original = box.onmousemove;
    box.__evrReadout = true;
    box.onmousemove = function (event) {
      const now = painterParts(window.Entry?.playground?.painter);
      if (!now?.home || now.box !== box) return original.call(this, event);
      const center = now.view.getCenter(), zoom = now.view.zoom;
      const dx = (center.x - now.home.x) * zoom, dy = (center.y - now.home.y) * zoom;
      if (Math.abs(dx) < .01 && Math.abs(dy) < .01) return original.call(this, event);
      return original.call(this, { offsetX: event.offsetX + dx, offsetY: event.offsetY + dy });
    };
  }
  // 글상자 입력칸(#guide_text): 엔트리는 중심이 home이라고 보고(center 속성) 위치(transform matrix)를 정한다. 실제 중심을
  // 옮긴 만큼((home - 중심) × 배율, 화면 px)을 더한다. 엔트리는 위치를 쓰자마자 focus()하므로 그 전에 바로잡는다(잘못된
  // 자리가 칸 밖이면 포커스가 칸을 스크롤시킨다). 그 밖의 위치 변경은 MutationObserver로 잡는다.
  function watchGuideText() {
    const guide = document.getElementById('guide_text');
    if (!guide || guide.__evrWatched) return;
    guide.__evrWatched = true;
    let written = '';
    const correct = () => {
      const transform = guide.style.transform, match = /^matrix\(([^)]*)\)$/.exec(transform || '');
      if (!match || transform === written) return;
      const values = match[1].split(',').map(Number);
      const ep = window.Entry?.playground?.painter?.entryPaint, home = homeCenter(ep), view = ep?.project?.view;
      if (values.length !== 6 || values.some(value => !Number.isFinite(value)) || !home || !view) return;
      const center = view.getCenter(), dx = (home.x - center.x) * view.zoom, dy = (home.y - center.y) * view.zoom;
      if (Math.abs(dx) < .01 && Math.abs(dy) < .01) return;
      guide.style.transform = `matrix(${values.slice(0, 4).join(', ')}, ${values[4] + dx}, ${values[5] + dy})`;
      written = guide.style.transform; // 브라우저가 숫자 형식을 바꿔 돌려주므로 읽은 값으로 비교(안 그러면 계속 더함)
    };
    new MutationObserver(correct).observe(guide, { attributes: true, attributeFilter: ['style'] });
    const focus = guide.focus;
    guide.focus = function (...args) { correct(); return focus.apply(this, args); };
  }
  // 글상자 입력 중에 확장으로 확대·이동하면, 엔트리 확대 버튼·손 도구를 누를 때처럼(포커스가 빠져 입력이 끝남) 입력을
  // 끝낸다. 그대로 두면 입력칸이 옛 화면 위치에 남는다.
  function endTextInput() {
    const guide = document.getElementById('guide_text');
    if (guide && document.activeElement === guide) guide.blur();
  }
  // 엔트리 이동(손) 도구(entry-paint Dr: 그림판 상자 left/top만 범위 안에서 옮김)는 250%를 넘기면 무대 끝까지 못 간다.
  // 그 배율에서 이동 도구가 켜져 있으면 왼쪽 끌기도 확장 이동으로 받는다(250% 이하는 엔트리 도구 그대로).
  function entryHandTool(parts) {
    const tool = parts.paper.tool;
    return parts.view.zoom > ENTRY_ZOOM_MAX + 1e-9 && tool?.targetEl === parts.box && 'dragMax' in tool;
  }
  // 엔트리는 비트맵(Raster)을 늘 보간해 그린다(paper 기본 smoothing "low"). 250%를 넘겨 보면 픽셀이 번져 보이므로,
  // 그 배율에서 편집기 화면 캔버스에 그릴 때만 보간을 끈다. 저장·합치기처럼 다른 캔버스에 그릴 때는 그대로다.
  function crispRasterDisplay(parts) {
    const proto = parts.paper.Raster?.prototype;
    if (!proto || own(proto, '__evrCrisp') || typeof proto._draw !== 'function') return;
    const original = proto._draw;
    Object.defineProperty(proto, '__evrCrisp', { value: true });
    proto._draw = function (ctx, ...rest) {
      const view = this._project?._view;
      if (this._smoothing === 'off' || !view || ctx?.canvas !== view._element ||
          !(view.getZoom() > ENTRY_ZOOM_MAX + 1e-9)) return original.call(this, ctx, ...rest);
      const smoothing = this._smoothing;
      this._smoothing = 'off';
      try { return original.call(this, ctx, ...rest); } finally { this._smoothing = smoothing; }
    };
  }
  // 엔트리 확대 버튼 묶음이 받는 onChange(백분율): view.zoom을 바꾸고 CHANGE_ZOOM과 배율 알림을 낸다.
  function entryZoomChange() {
    const node = document.querySelector('#entryPainter .ZoomControlComp');
    const key = node && Object.keys(node).find(name => /^__react(Fiber|InternalInstance)\$/.test(name));
    for (let fiber = key && node[key]; fiber; fiber = fiber.return)
      if (typeof fiber.memoizedProps?.onChange === 'function') return fiber.memoizedProps.onChange;
    return null;
  }
  // (clientX, clientY) 아래 그림 점이 그 자리에 머물게 배율을 바꾼다(없으면 보이는 칸 가운데).
  function zoomPainter(parts, zoom, clientX, clientY) {
    const { view, canvas, area, paper } = parts, next = clampTo(zoom, PAINTER_ZOOM.min, PAINTER_ZOOM.max);
    if (Math.abs(next - view.zoom) < 1e-6) return;
    endTextInput();
    const rect = canvas.getBoundingClientRect(), areaBox = area.getBoundingClientRect();
    const sx = clientX ?? areaBox.left + areaBox.width / 2, sy = clientY ?? areaBox.top + areaBox.height / 2;
    const unit = view.viewSize.width / rect.width || 1; // 화면 px → paper 보기 px
    const anchor = view.viewToProject(new paper.Point((sx - rect.left) * unit, (sy - rect.top) * unit));
    const change = entryZoomChange();
    if (change) change(Math.round(next * 100)); else view.zoom = next;
    const moved = view.projectToView(anchor);
    movePainterBox(parts, sx - rect.left - moved.x / unit, sy - rect.top - moved.y / unit);
  }
  // 확장 표시(기준점·뼈대)는 캔버스 위치에서 다시 그린다. 한 화면에 한 번만.
  const afterPainterView = () => {
    if (!viewFrame) viewFrame = requestAnimationFrame(() => { viewFrame = 0; refresh(); });
  };
  function ensurePainterNav(painter) {
    const parts = painterParts(painter);
    if (!parts) return;
    pinViewCenter(parts);
    pinRealign(parts);
    watchGuideText();
    fixMouseReadout(parts);
    crispRasterDisplay(parts);
    const { area } = parts;
    const zoomBox = document.querySelector('#entryPainter .ZoomControlComp');
    if (zoomBox && !zoomBox.dataset.evrNav) {
      zoomBox.dataset.evrNav = '1';
      // 엔트리 −/100%/+ 버튼: 엔트리 처리(React, 문서 쪽) 전에 받아 같은 단계로 바꾼다.
      zoomBox.addEventListener('click', event => {
        const button = event.target.closest?.('.zoomBtn'), now = painterParts(window.Entry?.playground?.painter);
        if (!button || !now) return;
        event.preventDefault();
        event.stopPropagation();
        if (button.classList.contains('default')) { // 100%로, 그림판·중심 모두 처음 자리로
          zoomPainter(now, 1);
          window.Entry.playground.painter.entryPaint.realign?.();
          if (now.home) now.view.setCenter(new now.paper.Point(now.home.x, now.home.y));
        } else zoomPainter(now, stepZoomFrom(now.view.zoom, button.classList.contains('zoomIn') ? 1 : -1,
          PAINTER_ZOOM.min, PAINTER_ZOOM.max));
        afterPainterView();
      });
    }
    if (area.dataset.evrNav) return;
    area.dataset.evrNav = '1';
    const current = () => {
      const now = painterParts(window.Entry?.playground?.painter);
      return now?.area === area ? now : null;
    };
    const wheelStep = wheelStepper();
    let pan = null;
    area.addEventListener('pointerenter', () => { painterHover = true; });
    area.addEventListener('pointerleave', () => { painterHover = false; });
    area.addEventListener('wheel', event => {
      const now = current();
      if (!now) return;
      event.preventDefault();
      const direction = wheelStep(event);
      if (!direction) return;
      zoomPainter(now, stepZoomFrom(now.view.zoom, direction, PAINTER_ZOOM.min, PAINTER_ZOOM.max),
        event.clientX, event.clientY);
      afterPainterView();
    }, { passive: false });
    area.addEventListener('contextmenu', event => event.preventDefault());
    // 이동 끌기는 그리기 도구(paper)에 가지 않게 캡처 단계에서 받는다. pointerdown을 막으면 이어지는 마우스
    // 이벤트(mousedown·mousemove·mouseup)도 생기지 않는다.
    area.addEventListener('pointerdown', event => {
      if (!(event.button === 0 || event.button === 1 || event.button === 2)) return;
      const now = current();
      if (!now || (event.button === 0 && !painterSpace && !entryHandTool(now))) return;
      event.preventDefault();
      event.stopPropagation();
      // 끄는 동안은 처음 위치에서 잰다(움직일 때마다 반올림하면 소수 좌표에서 오차가 쌓인다).
      endTextInput();
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, start: painterPan(now) };
      area.setPointerCapture(event.pointerId);
      area.classList.add('evr-panning');
    }, true);
    area.addEventListener('pointermove', event => {
      if (!pan || event.pointerId !== pan.id) return;
      event.stopPropagation();
      const now = current();
      if (!now) return;
      setPainterPan(now, pan.start.x + event.clientX - pan.x, pan.start.y + event.clientY - pan.y);
      afterPainterView();
    }, true);
    const end = event => {
      if (!pan || event.pointerId !== pan.id) return;
      event.stopPropagation();
      pan = null;
      area.classList.remove('evr-panning');
      afterPainterView();
    };
    area.addEventListener('pointerup', end, true);
    area.addEventListener('pointercancel', end, true);
  }
  // ---- 비트맵 편집기 끌기 격자 맞춤 ----
  // 엔트리 선택 도구는 끄는 동안 그림을 마우스 이동량(확대하면 소수)만큼 옮겨, 크게 보면 픽셀 그림이 반 칸씩
  // 부드럽게 움직이다 0.5초 뒤 tidyPixelPainter가 격자에 붙여 툭 튄다. 비트맵 모드에서는 끄는 동안 바로 픽셀 격자
  // (editorScale, 보통 1)에 맞춘다. 엔트리가 옮긴 양은 소수까지 따로 모아(true) 두고 보이는 위치만 반올림해, 천천히
  // 끌어도 멈추지 않는다. 크기·회전이 바뀌는 끌기(손잡이)는 건드리지 않는다.
  let snapDrag = null;
  function snapDragItems() {
    const drag = snapDrag;
    if (!drag?.c.layer) return;
    const { c, items, grid } = drag;
    for (const item of c.layer.children) {
      if (item.data?.entryVectorCanvasBox === '1') continue;
      let entry = items.get(item);
      const position = item.position, bounds = item.bounds;
      if (!entry) {
        items.set(item, entry = { x: position.x, y: position.y, shownX: position.x, shownY: position.y,
          width: bounds.width, height: bounds.height });
        continue;
      }
      if (Math.abs(bounds.width - entry.width) > 1e-6 || Math.abs(bounds.height - entry.height) > 1e-6) {
        entry.width = bounds.width; entry.height = bounds.height; // 크기·회전 바꾸는 중: 따라만 간다
        entry.x = entry.shownX = position.x; entry.y = entry.shownY = position.y;
        continue;
      }
      if (Math.abs(position.x - entry.shownX) < 1e-6 && Math.abs(position.y - entry.shownY) < 1e-6) continue;
      entry.x += position.x - entry.shownX; entry.y += position.y - entry.shownY;
      const x = Math.round((entry.x - bounds.width / 2) / grid) * grid + bounds.width / 2;
      const y = Math.round((entry.y - bounds.height / 2) / grid) * grid + bounds.height / 2;
      if (Math.abs(x - position.x) > 1e-6 || Math.abs(y - position.y) > 1e-6) item.position = new c.ep.paper.Point(x, y);
      entry.shownX = x; entry.shownY = y;
    }
  }
  window.addEventListener('pointerdown', event => {
    snapDrag = null;
    if (event.button !== 0 || painterSpace || !event.target?.closest?.('#entryPainter .canvas_area')) return;
    const c = context();
    if (!c || !bitmapMode(c)) return;
    snapDrag = { c, grid: editorScale(c), items: new Map(), id: event.pointerId };
    snapDragItems(); // 시작 위치를 재 둔다
  }, true);
  // 엔트리(paper)는 문서에서 이동을 받으므로, 창(window) 버블 단계에서 그 뒤에 맞춘다. paper가 마우스 이벤트(pointermove
  // 다음에 오는 mousemove)로 옮기는 경우도 있어 둘 다 받는다(두 번째는 바뀐 게 없어 그냥 지나감).
  window.addEventListener('pointermove', event => {
    if (snapDrag && event.pointerId === snapDrag.id && event.buttons & 1) snapDragItems();
  });
  window.addEventListener('mousemove', event => { if (snapDrag && event.buttons & 1) snapDragItems(); });
  window.addEventListener('pointerup', event => {
    if (!snapDrag || event.pointerId !== snapDrag.id) return;
    // 마지막 이동이 늦게 반영될 수 있어 한 번 더 맞춘 뒤 끝낸다.
    const drag = snapDrag;
    snapDragItems();
    setTimeout(() => { if (snapDrag === drag) { snapDragItems(); snapDrag = null; } }, 60);
  });
  // 스페이스: 편집기 위에 마우스가 있을 때만 이동 준비(글 입력 중이면 그대로 둔다).
  function painterKey(event) {
    if (event.key !== ' ') return;
    if (event.type === 'keydown') {
      if (event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable="true"], .evr-slicer')) return;
      if (!painterHover) return;
      painterSpace = true;
    } else if (!painterSpace) return;
    else painterSpace = false;
    document.querySelector('#entryPainter .canvas_area')?.classList.toggle('evr-pan-ready', painterSpace);
    event.preventDefault();
  }
  window.addEventListener('keydown', painterKey, true);
  window.addEventListener('keyup', painterKey, true);
  window.addEventListener('blur', () => {
    painterSpace = false;
    document.querySelector('#entryPainter .canvas_area')?.classList.remove('evr-pan-ready');
  });
  function refresh() {
    inkGeneration++;
    const c = context();
    const painter = window.Entry?.playground?.painter;
    if (painter) {
      ensureSaveHook(painter);
      ensureLoadHook(painter);
      try { ensurePainterNav(painter); } catch (error) { console.warn('[entry-vector-rig] 편집기 이동·확대', error); }
    }
    ensurePixelDrawHook();
    const entity = window.Entry?.container?.selectedObject?.entity;
    if (entity?.setImage) ensurePivotHook(entity);
    let normalized = false;
    for (const object of window.Entry?.container?.getAllObjects?.() || []) {
      const sprite = object.entity;
      if (!sprite || !hasNativeCanvas(object) ||
          (Math.abs(sprite.getRegX() - sprite.getWidth() / 2) <= .001 &&
           Math.abs(sprite.getRegY() - sprite.getHeight() / 2) <= .001)) continue;
      sprite.setRegX(sprite.getWidth() / 2);
      sprite.setRegY(sprite.getHeight() / 2);
      normalized = true;
    }
    if (normalized) window.Entry.stage.updateObject();
    if (session && !current(session)) close();
    reconcilePivots(window.Entry?.container?.selectedObject);
    pendingSaves = pendingSaves.filter(record =>
      Date.now() - record.at < 30000 && !settleSave(record));
    measureMissingArt(window.Entry?.playground?.object);
    adoptPixelPictures(window.Entry?.playground?.object);
    restorePixelFileurls();
    if (c) tidyPixelPainter(c);
    refreshPivotUI(c);
    ensureRigModeButton(c);
    if (session) draw(session);
    const top = document.getElementById('entryPainter')?.querySelector('.top_area');
    ensureToolButtons(c, top);
    // 오브젝트 추가하기 창 탭은 덧붙인 기능이라 맨 끝에 두고, 오류가 나도 위의 저장·모양 처리를 막지 않게 한다.
    try { ensureAddObjectTab(); } catch (error) { console.warn('[entry-vector-rig] 오브젝트 추가 탭', error); }
  }
  // 픽셀 아트 · 스프라이트 나누기 · 그림 전체 이동 · 모양 어니언. 엔트리 "모양 가져오기 · 저장하기"
  // 묶음(오른쪽 위) 맨 앞에 같은 모양으로 둔다. 엔트리 버튼 감싸개 안에는 넣지 않는다.
  function ensureToolButtons(c, top) {
    let tools = top?.querySelector('.evr-tools');
    if (!c || !top) { tools?.remove(); return; }
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'evr-tools';
      const more = button('도구 ▾', () => {
        tools.dataset.open = String(tools.dataset.open !== 'true');
      }, { class: 'evr-tools-more', title: '확장 도구' });
      const list = document.createElement('div');
      list.className = 'evr-tools-list';
      const pixel = button('픽셀 아트', () => runButton(pixel, async () => {
        const selected = context();
        if (!selected) return;
        await setObjectPixel(selected.object, !(objectPixel(selected.object) > 0));
      }), { class: 'evr-tool evr-pixel', 'aria-pressed': 'false',
        title: '이 오브젝트를 픽셀 아트로(보간 없음). 모양들을 SVG 한 장으로 묶어 확장을 꺼도 각지게 보이게 함' });
      const split = button('스프라이트 나누기', () => {
        const selected = context();
        if (selected) openSlicer(selected);
      }, { class: 'evr-tool evr-sheet',
        title: '스프라이트 시트를 자동(투명 배경)·칸 크기·칸 개수로 잘라 모양으로 추가' });
      const align = button('중심 맞추기', () => runButton(align, async () => {
        const selected = context();
        if (selected) await openCenterDialog(selected);
      }), { class: 'evr-tool evr-align',
        title: '창에서 맞출 기준점(3×3)을 골라 이 오브젝트의 비트맵 모양들을 맞추고 가운데에 둠(미리보기, 되돌리기 가능)' });
      const center = button('그림 전체 이동', () => {
        if (session) close();
        const selected = context();
        if (!selected) return;
        refreshPivotUI(selected);
        if (!pivotUI) return;
        pivotUI.adjusting = !pivotUI.adjusting;
        pivotUI.overlay.dataset.adjusting = String(pivotUI.adjusting);
        center.setAttribute('aria-pressed', String(pivotUI.adjusting));
      }, { class: 'evr-tool evr-center-mode', 'aria-pressed': 'false',
        title: '회색 십자는 고정 · 그림을 끌어서 회전 중심 맞추기' });
      const onion = button('모양 어니언', () => {
        costumeOnionEnabled = !costumeOnionEnabled;
        onion.setAttribute('aria-pressed', String(costumeOnionEnabled));
        drawPivotUI();
      }, { class: 'evr-tool evr-costume-onion',
        'aria-pressed': String(costumeOnionEnabled),
        title: '엔트리 모양 목록의 바로 이전·다음 모양 표시' });
      const arrange = button('모양 맞추기', () => runButton(arrange, async () => {
        const selected = context();
        if (selected) await openAligner(selected);
      }), { class: 'evr-tool evr-arrange',
        title: '여러 모양을 한 화면에서 고르고 함께 옮겨 맞춤(기준 모양·앞뒤 겹쳐 보기, 재생, 격자 단위 이동)' });
      const pin = button('기준 모양', () => {
        const selected = context();
        if (!selected) return;
        const id = selected.object.id;
        if (pinnedPictures.get(id) === selected.picture.id) pinnedPictures.delete(id);
        else pinnedPictures.set(id, selected.picture.id);
        drawPivotUI();
      }, { class: 'evr-tool evr-pin', 'aria-pressed': 'false',
        title: '지금 모양을 기준으로 고정해 다른 모양에서도 겹쳐 보기(그 모양에서 다시 누르면 해제)' });
      list.append(pixel, split, arrange, align, center, onion, pin);
      // 접힌 목록에서 하나를 고르면 목록을 닫는다(버튼 동작이 먼저 실행된 뒤).
      list.addEventListener('click', () => { tools.dataset.open = 'false'; });
      tools.append(more, list);
    }
    const save = [...top.querySelectorAll('button')].find(b => b.textContent.trim() === '저장하기');
    const box = save?.parentElement?.parentElement || top;
    if (tools.parentElement !== box) box.prepend(tools);
    const pixel = tools.querySelector('.evr-pixel'), on = objectPixel(c.object) > 0;
    if (pixel.getAttribute('aria-pressed') !== String(on)) pixel.setAttribute('aria-pressed', String(on));
    const pin = tools.querySelector('.evr-pin'), pinnedId = pinnedPictures.get(c.object.id);
    const pinnedIndex = c.object.pictures.findIndex(picture => picture.id === pinnedId);
    const pinState = String(pinnedIndex >= 0);
    if (pin.getAttribute('aria-pressed') !== pinState) pin.setAttribute('aria-pressed', pinState);
    pin.textContent = pinnedIndex >= 0 ? `기준 모양 ${pinnedIndex + 1}` : '기준 모양';
    fitTools(tools, box);
  }
  // 엔트리 오른쪽 묶음은 오른쪽에 붙은 absolute 상자라, 버튼이 많으면 왼쪽의 "비트맵 | 벡터 | 뼈대"를
  // 덮는다. 펼친 너비가 들어가지 않으면 "도구 ▾" 하나로 접고, 그래도 모자라면 뼈대 버튼 글자를 숨겨 아이콘만
  // 둔다(화면 폭 1280px에서 접어도 13px 겹침 실측). 판단은 늘 펼친·글자 있는 너비로 해서 왔다 갔다 하지 않는다.
  // 폭 1267px보다 좁으면 엔트리 자기 버튼과도 겹쳐 한 줄에 다 들어가지 않는다(그대로 둠).
  function fitTools(tools, box) {
    const panel = box.parentElement;
    const boxRect = box.getBoundingClientRect();
    if (!panel || !boxRect.width) return;
    const list = tools.querySelector('.evr-tools-list'), more = tools.querySelector('.evr-tools-more');
    if (tools.dataset.compact !== 'true') tools.dataset.full = String(Math.ceil(list.getBoundingClientRect().width));
    else tools.dataset.more = String(Math.ceil(more.getBoundingClientRect().width));
    const margin = (node, side) => parseFloat(getComputedStyle(node)[side]) || 0;
    const others = [...box.children].filter(node => node !== tools)
      .reduce((sum, node) => sum + node.getBoundingClientRect().width + margin(node, 'marginLeft'), 0);
    const wrap = document.querySelector('.evr-mode-wrap[data-evr-mode="bone"]');
    const label = wrap?.querySelector('.evr-bone-mode span');
    if (label && wrap.dataset.narrow !== 'true')
      wrap.dataset.label = String(Math.ceil(label.getBoundingClientRect().width + margin(label, 'marginLeft')));
    const hidden = wrap?.dataset.narrow === 'true' ? Number(wrap.dataset.label || 0) : 0;
    const left = Math.max(0, ...[...panel.children]
      .filter(node => node !== box && !/^(absolute|fixed)$/.test(getComputedStyle(node).position))
      .map(node => node.getBoundingClientRect().right + margin(node, 'marginRight')),
    wrap ? wrap.getBoundingClientRect().right + margin(wrap, 'marginRight') : 0) + hidden;
    const start = width => boxRect.right - others - width - 8;
    const compact = start(Number(tools.dataset.full || 0)) < left;
    const narrow = compact && start(Number(tools.dataset.more || 68)) < left;
    if (tools.dataset.compact !== String(compact)) {
      tools.dataset.compact = String(compact);
      tools.dataset.open = 'false';
    }
    if (wrap && wrap.dataset.narrow !== String(narrow)) wrap.dataset.narrow = String(narrow);
  }
  setInterval(refresh, 500);
  // 엔트리의 "비트맵 | 벡터" 버튼을 누르면 뼈대 모드에서 나온다(묶음 안의 버튼이면 무엇이든).
  // 접힌 도구 목록은 바깥을 누르면 닫는다.
  document.addEventListener('click', event => {
    if (session && event.target.closest?.('#entryPainter .modeSpace button')) close();
    const tools = document.querySelector('#entryPainter .evr-tools[data-open="true"]');
    if (tools && !tools.contains(event.target)) tools.dataset.open = 'false';
    // 오브젝트 추가하기 창: 엔트리 탭을 누르면 우리 탭을 내려 놓고(엔트리가 화면을 바꿈), 우리 탭이
    // 켜져 있을 때 오른쪽 위 "추가하기"는 엔트리 동작 대신 새 오브젝트를 만든다.
    if (sheetTab?.active) {
      const item = event.target.closest?.('li');
      if (item && item.parentElement === sheetTab.list && item !== sheetTab.li) deactivateSheetTab(true);
      const button = event.target.closest?.('a, button');
      if (sheetTab.active && button && sheetTab.wrap?.contains(button) &&
          !sheetTab.panel?.contains(button) && button.textContent.trim() === '추가하기') {
        event.preventDefault();
        event.stopImmediatePropagation();
        sheetTab.ui?.run();
      }
    }
    // 창이 뜨자마자 탭이 보이도록 클릭 직후 한 번 더 찾는다(주기 갱신은 0.5초 간격).
    setTimeout(ensureAddObjectTab, 60);
  }, true);
  refresh();
})();
