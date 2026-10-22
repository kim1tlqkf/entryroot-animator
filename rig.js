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
    // 무대 = 엔트리 무대 크기 틀(Shape). 확장 작업 영역(캔버스 크기)을 쓰면 그 칸 — 무한 배경으로 틀을 둘레까지
    // 넓혀도 그림 칸은 가운데 한 칸이다(areaTile).
    const stage = areaTile(ep) || layers[0].parent.children.find(item =>
      item.className === 'Shape')?.bounds;
    return { layer: layers[0], stage };
  }
  function pictureSwitching() {
    const E = window.Entry, p = E?.playground?.painter, object = E?.container?.selectedObject;
    return !!(p && object?.selectedPicture && (p.__evrLoading || (p.file?.id && p.file.id !== object.selectedPicture.id)));
  }
  function context() {
    const E = window.Entry, p = E?.playground?.painter, ep = p?.entryPaint;
    const object = E?.container?.selectedObject;
    const root = document.getElementById('entryPainter');
    if (!root || !root.getClientRects().length || !object?.selectedPicture ||
        E.playground.object !== object || !ep?.project ||
        !['VECTOR', 'BITMAP'].includes(ep.mode)) return null;
    // 모양을 바꾸는 동안은 선택 모양이 먼저 바뀌고 편집기 그림은 아직 앞 모양 것이다(비동기 불러오기, 저장 확인창이 떠 있는 동안 —
    // 확인창 동안 file.id는 앞 모양). 그 사이 0.5초 갱신이 새 모양 정보에 앞 모양 그림 기준 값(기준점·상자 표시)을 쓰지 않게
    // 비워 둔다(검토로 찾음 2026-10-16 — 무한 배경 접기에서 같은 틈이 실제로 재현됨).
    if (pictureSwitching()) return null;
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
  // entryVectorAtlas). 모양 PNG(파일 이름)는 그대로라 fileurl이 빠지면 보통 그림으로 보인다. 파일 이름이 없던 라이브러리 그림은
  // 칸 주소를 걸기 전에 자기 파일을 만든다(ownPictureFile — 안 그러면 .ent를 거치면 그 모양 그림 단서가 사라져 작품이 안 열림).
  // 예전 방식(PNG를 k배로 키우고 오브젝트 크기 1/k, entryVectorPixel = k > 1)으로 만든 오브젝트도 그대로 쓴다.
  // 편집기에서는 원래 해상도로 열어 실제 픽셀을 다룬다. 그림 퍼짐 기록과 공통 크기는 그림 단위(원래 픽셀)로 둔다.
  const PIXEL_MARGIN = 1;
  const pixelOf = picture => {
    const k = Number(picture?.dimension?.entryVectorPixel);
    return Number.isInteger(k) && k >= 1 && k <= 64 ? k : 0;
  };
  const objectPixel = object =>
    (object?.pictures || []).reduce((k, picture) => k || pixelOf(picture), 0);
  // 벡터 픽셀 모양(원본이 벡터): 실행 화면은 엔트리가 SVG와 함께 저장한 PNG를 아틀라스 칸(pixelated)으로 그리고, 편집기는 원래
  // SVG(벡터)로 연다. 저장·크기 맞추기·새로 들어온 뒤에는 새 PNG로 칸을 다시 올린다(repixelVector). 1배 픽셀(아틀라스)만.
  const PIXEL_VECTOR = 'entryVectorPixelSource';
  const pixelVector = picture => pixelOf(picture) === 1 && picture?.dimension?.[PIXEL_VECTOR] === 'svg';
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
    // 비트맵 탭은 그림 층 맨 앞(children[0])을 그림(Raster)으로 쓴다(지우개 targetRaster, 선택 잘라 내기, 빈 그림 검사 —
    // entry-paint 260921). 상자를 맨 앞에 두면 저장 직후 첫 지우개 획이 오류로 안 지워졌다(1.1.0 실제 엔트리 재현,
    // 확장 없이는 지워짐). 비트맵은 맨 위에 둔다(다음 획을 구울 때 그림에 합쳐짐). 벡터는 그림 아래 그대로.
    if (bitmapMode(c)) c.layer.addChild(box);
    else c.layer.insertChild(0, box);
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
    const raster = ownRasterize(c.layer, { resolution: 72, insert: false });
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
      // 그림판 파일 이름은 그 파일 id의 모양 이름으로 맞춘다. 엔트리 모양 목록의 이름 칸은 칸을 떠날 때(blur) 열린 모양이 아니어도 그림판 파일
      // 이름을 그 칸 모양 이름으로 바꾼다(entry.min.js 이름 칸: painter.file.name = 칸 글, id 확인 없음). 그린 뒤 다음 모양의 이름 칸을 눌러
      // "저장할까요?" [확인]을 누르면 그 순간 이름 칸을 떠나, 저장한 앞 모양이 다음 모양 이름이 됐다(10-19 사용자 제보 "ID로 관리돼지 않아서
      // 섞이는게 발생" 조사 중 확장 없이도 재현 — 이름이 둘 다 같아짐). 모양 이름을 직접 고치면 엔트리가 모양 정보 이름도 같이 바꾸므로 그대로다.
      try {
        const file = this.file, E = window.Entry;
        const owner = (file?.objectId && E?.container?.getObject?.(file.objectId)) || E?.playground?.object;
        const model = owner?.pictures?.find?.(picture => picture.id === file.id);
        if (model && typeof model.name === 'string' && file.name !== model.name) file.name = model.name;
      } catch (error) { console.warn('[entry-vector-rig] 모양 이름 맞추기', error); }
      // 비트맵 레이어: 저장하는 동안만 그림 층에 합친 그림을 넣는다(아래 무한 배경·기준점 상자·PNG 처리가 모두 합친 그림으로)
      let layerSwap = null;
      try { layerSwap = beginLayerSave(this.entryPaint); } catch (error) { console.warn('[entry-vector-rig] 레이어 저장 준비 실패', error); }
      // 확장 쪽 준비가 실패해도 엔트리 원래 저장은 그대로 실행한다.
      // 무한 배경 비트맵은 그림 칸 그대로 저장한다: 기준점 상자·여백·공통 크기 맞추기를 하지 않는다(칸 크기가 바뀌면 이음매가 어긋남).
      let prepared = null, tile = null;
      try {
        const sc = this.entryPaint?.mode === 'BITMAP' && wrapOn(this.entryPaint) && areaTile(this.entryPaint) &&
          window.Entry?.stage?.selectedObject ? saveContext(this) : null;
        if (sc) {
          canvasBox(sc)?.remove();
          const art = wrapTileCanvas(this.entryPaint);
          // 픽셀 아트 모양은 prepareSave처럼 k배 PNG + pixelated SVG로(원래 해상도로 연 모양만 k배로 굽는다)
          const k = pixelOf(sc.picture), bake = k && editorScale(sc) === 1 ? k : 0;
          const payload = art && bake ? pixelPayload(art, bake) : null;
          const png = payload ? payload.image : art?.toDataURL('image/png');
          if (pngSize(png)) tile = { c: sc, png, svg: payload?.svg || null, pixel: k, mode: this.file?.mode,
            before: new Map(sc.object.pictures.map(picture => [picture.id, pictureKey(picture)])) };
        }
      } catch (error) { console.warn('[entry-vector-rig] 무한 배경 저장 준비 실패', error); }
      // 비트맵 뼈대: PNG에는 그림 데이터가 남지 않으므로 관절을 모양 정보에 남긴다(저장한 모양 = 지금 자세가 새 기준).
      // 새 모양으로 저장하면 원래 모양은 그대로 남으니 원래 모양에는 휘기 전 관절을 남긴다(다음에 열어 다른 자세를 잡게).
      let bitmapRig;
      try {
        const sc = this.entryPaint?.mode === 'BITMAP' && window.Entry?.stage?.selectedObject ? saveContext(this) : null;
        if (sc) {
          // 그림에 뼈대 데이터가 없으면(이번에 뼈대 모드를 안 열고 PNG로 다시 연 모양) 예전 기록을 그대로 둔다. 뼈를 모두
          // 지웠을 때는 뼈대 모드가 그때 기록을 지운다(deleteJoint).
          const raster = sc.layer.children.find(item => isRasterLayer(item) && item.data?.[BONES]);
          let rig = null;
          try { rig = raster && JSON.parse(raster.data[BONES]); } catch { rig = null; }
          if (rig) rig = rigMovedTo(rig, rasterSig(raster));
          bitmapRig = !raster ? undefined : rig && validRig(rig) && rig.joints.length > 1 ? bitmapRigRecord(sc, rig, false) : null;
          if (rig && bitmapRig && this.file?.mode === 'new' && sc.picture.dimension)
            sc.picture.dimension[BITMAP_RIG] = bitmapRigRecord(sc, rig, true);
          // 레이어 모양의 관절은 레이어마다 레이어 원본에 담는다(layerSvg). 모양 하나짜리 기록은 지운다 — 남기면 다시 열 때 지금 레이어에 붙는다.
          // k배 픽셀 모양은 다시 열 때 레이어를 읽지 않고 합친 그림으로 여므로 기록을 그대로 둔다.
          // 레이어를 한 장으로 줄여 저장하면 그 레이어 뼈대(파일에서 읽고 아직 안 연 관절, 필터 등으로 그림 data가 비어 레이어 쪽에만 남은 뼈대)를
          // 모양 기록으로 남긴다.
          const meta = layerMeta(this.entryPaint);
          if (layerSwap) { if (!(pixelOf(sc.picture) > 1)) bitmapRig = null; }
          else if (bitmapRig === undefined && meta) {
            const record = layerJointsRecord(activeLayer(meta), crossPoint(sc));
            if (record) bitmapRig = JSON.stringify(record);
          }
        }
      } catch (error) { console.warn('[entry-vector-rig] 비트맵 뼈대 기록 실패', error); }
      if (!tile) {
        try { prepared = prepareSave(this); }
        catch (error) { console.warn('[entry-vector-rig] 저장 준비 실패', error); }
      }
      // 실행 화면은 SVG가 아니라 함께 올린 PNG를 모양 크기에 맞춰 그린다. 엔트리 PNG는 무대 밖을
      // 잘라내 모서리 점이 사라지므로, 벡터는 저장하는 동안만 그림 전체 범위 PNG로 바꿔 넣는다.
      const ep = this.entryPaint;
      let fullPng = tile?.png || null, pixelSvg = tile?.svg || null, vectorTile = false, pixelArt = null;
      if (prepared && (!bitmapMode(prepared.c) || prepared.bake)) {
        try {
          if (prepared.bake) {
            // 픽셀 모양: k배 PNG와 SVG(pixelated)를 함께 만든다.
            const art = savedBitmapArt(prepared.c);
            if (art) ({ image: fullPng, svg: pixelSvg } = pixelPayload(art, prepared.bake));
          } else if (wrapOn(ep) && areaTile(ep)) {
            // 무한 배경 벡터: 실행 화면 PNG는 칸 그대로, 칸 끝을 넘은 부분은 반대쪽에 접어 넣는다(비트맵 무한 배경과 같은 collapsedTile —
            // 화면의 쌍둥이 사본과 같은 모습). SVG는 원래 도형 그대로라(기준점 상자로 다시 열 때 자리가 맞음) 확장이 다시 열면 이어
            // 보여 준다. 공통 크기 맞추기는 하지 않는다(칸 크기가 바뀌면 이음매가 어긋남).
            const png = vectorWrapTileCanvas(ep)?.toDataURL('image/png');
            if (pngSize(png)) { fullPng = png; vectorTile = true; }
          } else {
            const raster = prepared.c.layer.rasterize({ resolution: 72, insert: false }), png = raster.toDataURL();
            if (pngSize(png)) fullPng = png;
            if (pixelVector(prepared.c.picture))
              pixelArt = entryBitmapCanvas(ep.paper, prepared.c.layer.children, raster.bounds);
          }
        } catch (error) { console.warn('[entry-vector-rig] 전체 PNG 만들기 실패', error); }
      }
      const ownGetter = !!ep && Object.prototype.hasOwnProperty.call(ep, 'getDataURL');
      const previousGetter = ep?.getDataURL;
      if (fullPng) ep.getDataURL = () => fullPng;
      // 픽셀 모양은 엔트리 저장 요청에 SVG를 붙여 올린다. fileurl은 저장이 끝난 뒤 settleSave에서 건다.
      const E = window.Entry, previousDispatch = E.dispatchEvent;
      const ownDispatch = Object.prototype.hasOwnProperty.call(E, 'dispatchEvent');
      // 비트맵 레이어는 같은 저장 요청에 레이어 원본 SVG를 붙인다(보이는 것은 엔트리가 만든 합친 PNG).
      // 모양 크기는 이때 실린 그림으로 잰다 — 저장 뒤엔 그림 층이 지금 레이어 한 장으로 돌아가 그 레이어 크기가 나온다.
      let sentImage = null;
      if (pixelSvg || layerSwap) E.dispatchEvent = function (name, payload, ...rest) {
        if (name === 'saveCanvasImage' && payload?.file) {
          sentImage = payload.image;
          let svg = pixelSvg;
          try { if (layerSwap) svg = layerSvg(layerSwap, payload.image, pixelSvg) || pixelSvg; }
          catch (error) { console.warn('[entry-vector-rig] 레이어 SVG 만들기 실패', error); }
          if (svg) {
            payload.file.ext = 'svg';
            payload.file.svg = svg;
          }
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
        if (pixelSvg || layerSwap) {
          if (ownDispatch) E.dispatchEvent = previousDispatch;
          else delete E.dispatchEvent;
        }
        try { endLayerSave(layerSwap); } catch (error) { console.warn('[entry-vector-rig] 레이어 되돌려 놓기 실패', error); }
      }
      const layerCount = layerSwap ? layerSwap.meta.layers.length : 0;
      if (tile) pendingSaves.push({ object: tile.c.object, pictureId: tile.c.picture.id, mode: tile.mode,
        before: tile.before, size: pngSize(tile.png), tile: true, pixel: tile.pixel, pixelSvg: !!tile.svg, bitmapRig, layers: layerCount, at: Date.now() });
      try {
        const size = prepared && (pngSize(fullPng) || (layerSwap && pngSize(sentImage)) || savedSize(prepared.c, this.file?.svg));
        if (size) pendingSaves.push({ object: prepared.c.object,
          pictureId: prepared.c.picture.id, mode: prepared.mode,
          before: prepared.before, size, art: prepared.art, pixel: prepared.pixel, tile: vectorTile,
          pixelVector: pixelVector(prepared.c.picture) && !bitmapMode(prepared.c), pixelArt,
          pixelSvg: !!pixelSvg, bitmapRig, layers: layerCount, at: Date.now() });
      } catch (error) { console.warn('[entry-vector-rig] 저장 크기 확인 실패', error); }
      // 엔트리 저장과 동시에 다른 모양도 공통 크기로 맞춘다.
      try {
        if (prepared && !vectorTile) startUnify(prepared.c.object, prepared.common,
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
    // 비트맵 뼈대 관절(십자 기준). 그림에 뼈대가 있었는데 다 지웠으면(null) 예전 기록을 지우고, 뼈대 데이터가 없던
    // 저장(undefined)은 그대로 둔다. 벡터는 SVG에 뼈대가 남아 건드리지 않는다.
    if (record.bitmapRig) picture.dimension[BITMAP_RIG] = record.bitmapRig;
    else if (record.bitmapRig === null) delete picture.dimension[BITMAP_RIG];
    // 비트맵 레이어: 같은 파일 이름으로 합친 PNG와 레이어 원본 SVG가 올라갔다(서버는 SVG로 받으면 둘 다 둔다). 모양은 비트맵(png)으로
    // 둬서 실행 화면·확장 없는 편집기·다른 비트맵 기능은 합친 PNG를 그대로 쓰고, 확장은 표시를 보고 SVG에서 레이어를 꺼낸다.
    // (.ent에는 PNG만 묶이므로 내려받을 때 레이어 원본을 모양 정보에 담는다 — withEntLayers.) 레이어 없이 다시 저장하면 표시를 지운다.
    // 벡터 픽셀 모양: 표시를 남기고, 옛 칸(이전 그림) 대신 새 PNG로 칸을 다시 올린다(올라가기 전에는 보간된 새 PNG)
    if (record.pixelVector) {
      picture.dimension[PIXEL_VECTOR] = 'svg';
      delete picture.fileurl;
      repixelVector(object, picture.id, record.pixelArt);
    } else delete picture.dimension[PIXEL_VECTOR];
    if (record.layers) {
      picture.dimension[LAYER_MARK] = { v: 1, n: record.layers };
      if (!record.pixelSvg) { picture.imageType = 'png'; delete picture.fileurl; }
    } else delete picture.dimension[LAYER_MARK];
    delete picture.dimension[LAYER_ENT];
    // 무한 배경 칸: 공통 크기 맞추기 대상에서 뺀다(다른 모양을 저장해도 칸 크기가 바뀌지 않게).
    // 픽셀 아트 모양은 다른 저장과 같이 k 표시와 SVG(pixelated)를 건다.
    if (record.tile) {
      for (const key of ['entryVectorNativeCanvas', 'entryVectorArt', 'entryVectorPivot', 'entryVectorAtlas'])
        delete picture.dimension[key];
      if (record.pixel) picture.dimension.entryVectorPixel = record.pixel;
      if (record.pixelSvg && picture.filename) {
        picture.fileurl = svgFile(picture.filename);
        picture.imageType = 'svg';
      }
      pivotRecords.get(object)?.delete(picture.id);
      if (object.entity?.picture?.id === picture.id) {
        object.entity.setImage(picture);
        object.entity.setRegX(object.entity.getWidth() / 2);
        object.entity.setRegY(object.entity.getHeight() / 2);
        window.Entry.stage.updateObject();
      }
      return true;
    }
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
  async function readSvg(picture, { boxOptional = false } = {}) {
    // 벡터 픽셀 모양의 모양 주소는 실행 화면용 아틀라스 칸이라, 원래 SVG(벡터)를 읽는다
    const source = pixelVector(picture) && (picture.filename ? svgFile(picture.filename) : atlasOf(picture)?.base);
    const response = await fetch(source || window.Entry.playground.painter.getImageSrc(picture));
    if (!response.ok) throw Error(`SVG를 읽을 수 없습니다 (${response.status})`);
    const root = new DOMParser().parseFromString(await response.text(), 'image/svg+xml')
      .documentElement;
    const view = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    if (root.nodeName !== 'svg' || view?.length !== 4 || !view.every(Number.isFinite) ||
        !(view[2] > 0 && view[3] > 0)) throw Error('viewBox가 없는 SVG입니다.');
    const box = [...root.children].find(isBoxNode) || null;
    if (!box && !boxOptional) throw Error('기준점 상자가 없는 SVG입니다.');
    return { root, view, box };
  }
  // SVG 보이는 범위를 (left, top, size)로 두고 기준점 상자(네 귀퉁이 2px 점, 확장 저장과 같은 표시)를 그 귀퉁이에 둔다. 상자가
  // 없던 SVG(엔트리 기본 모양 등)는 상자를 새로 넣는다 — 다시 열 때 엔트리가 그림 범위 가운데를 십자에 맞추므로 상자가 있어야 자리가 맞다.
  function placeSvgBox(root, box, left, top, size) {
    if (!box) {
      box = root.ownerDocument.createElementNS(NS, 'g');
      box.setAttribute('data-paper-data', JSON.stringify({ entryVectorCanvasBox: '1' }));
      root.insertBefore(box, root.firstChild);
    }
    box.removeAttribute('transform');
    box.replaceChildren(...cornersOf(size).map(([x, y]) => {
      const dot = root.ownerDocument.createElementNS(NS, 'path');
      dot.setAttribute('d', `M${left + x},${top + y}h2v2h-2z`);
      dot.setAttribute('fill', '#000000');
      dot.setAttribute('fill-opacity', '0.01');
      return dot;
    }));
    root.setAttribute('viewBox', `${left} ${top} ${size.width} ${size.height}`);
  }
  // 벡터 모양을 맞춘 SVG·PNG: center(SVG 좌표)가 틀(box) 가운데에 오게 보이는 범위만 옮긴다(도형은 그대로)
  async function alignedSvg(vector, center, box) {
    const root = vector.root.cloneNode(true);
    placeSvgBox(root, [...root.children].find(isBoxNode) || null, center.x - box.width / 2, center.y - box.height / 2, box);
    const canvas = await renderSvg(root, box.width, box.height);
    return { canvas, payload: { ext: 'svg', svg: new XMLSerializer().serializeToString(root), image: canvas.toDataURL('image/png'), size: { ...box } } };
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
    const left = Math.floor((size.width - image.naturalWidth) / 2), top = Math.floor((size.height - image.naturalHeight) / 2);
    context.drawImage(image, left, top);
    context.fillStyle = 'rgba(0, 0, 0, 0.01)';
    for (const [x, y] of cornersOf(size)) context.fillRect(x, y, 2, 2);
    // shift: 그림이 십자(그림 가운데) 기준으로 옮겨진 거리 — 홀수 차이면 반 칸(레이어 원본 자리를 같이 옮길 때 씀)
    return { ext: 'png', image: canvas.toDataURL('image/png'), size,
      shift: { x: left + image.naturalWidth / 2 - size.width / 2, y: top + image.naturalHeight / 2 - size.height / 2 } };
  }
  // 픽셀 모양은 원래 해상도에서 여백을 맞춘 뒤 SVG 방식으로 다시 만든다(size는 k배 크기).
  async function resizedPixel(picture, size, k) {
    const art = await pixelArtOf(picture);
    const target = { width: Math.round(size.width / k), height: Math.round(size.height / k) };
    const canvas = canvasOfSize(target.width, target.height), context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    const left = Math.floor((target.width - art.width) / 2), top = Math.floor((target.height - art.height) / 2);
    context.drawImage(art, left, top);
    context.fillStyle = 'rgba(0, 0, 0, 0.01)';
    for (const [x, y] of cornersOf(target)) context.fillRect(x, y, 2, 2);
    return { ...pixelPayload(canvas, k), shift: { x: left + art.width / 2 - target.width / 2, y: top + art.height / 2 - target.height / 2 } };
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
      imageType: payload.imageType || payload.ext, dimension });
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
  // 하나가 실패하면 새 작업은 시작하지 않는다(부른 쪽은 전체를 실패로 끝내므로 남은 불러오기·업로드는 헛일·고아 파일이 된다).
  async function runLimited(tasks, limit) {
    let next = 0, failed = false;
    const worker = async () => {
      while (!failed && next < tasks.length) {
        try { await tasks[next++](); } catch (error) { failed = true; throw error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  }
  let unifyRunning = 0; // 도는 공통 크기 맞추기 수(ownPixelPictures가 그동안 미룸)
  function startUnify(object, common, skipId) {
    const generation = (unifyGeneration.get(object) || 0) + 1;
    unifyGeneration.set(object, generation);
    const isCurrent = () => unifyGeneration.get(object) === generation;
    const painter = window.Entry?.playground?.painter;
    const area = painter?.entryPaint?.project && paintLayer(painter.entryPaint)?.stage;
    // 비트맵 모양은 편집기 캔버스가 무대 크기라 무대 안까지만 맞춘다. 픽셀 모양은 k배로 저장한다. 지금 모양의 작업 영역을
    // 넓혔으면 그만큼까지(다른 모양도 확장으로 열면 그 크기로 넓어짐). 좁혔어도 기본 무대보다 작게 자르지는 않는다
    // (작게 잡은 한 모양 때문에 다른 모양이 잘려 다시 올라가지 않게).
    const stage = area && { width: Math.max(AREA_DEFAULT.w, area.width), height: Math.max(AREA_DEFAULT.h, area.height) };
    // 상한은 그 모양의 지금 크기보다 작게 하지 않는다: 캔버스를 키워 저장한 큰 비트맵(예: 1600×1200)이 다른 모양을 기본 크기로
    // 저장할 때 960×540으로 잘려 다시 올라갔다(실제 엔트리 재현, 업로드는 가로챔). 작은 모양은 예전처럼 무대 크기까지만 키운다.
    const sizeOf = picture => {
      const k = pixelOf(picture) || 1;
      const own = { x: Math.ceil(Number(picture.dimension?.width) / k / 2) || 0, y: Math.ceil(Number(picture.dimension?.height) / k / 2) || 0 };
      const half = picture.imageType === 'png' && stage ? {
        x: Math.min(common.x, Math.max(Math.floor(stage.width / 2), own.x)),
        y: Math.min(common.y, Math.max(Math.floor(stage.height / 2), own.y)) } : common;
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
        const layered = !!picture.dimension?.[LAYER_MARK];
        if (pixel && !pixelVector(picture)) {
          let payload = await resizedPixel(picture, size, pixel), gone = false;
          if (layered) {
            try { payload = await withLayerOriginal(picture, payload, payload.shift); }
            catch (error) { if (!error.missing) throw error; gone = true; }
          }
          // 레이어 원본이 이미 없는 모양은 레이어 표시를 지우고 보통 그림으로 맞춘다(계속 건너뛰며 저장마다 경고하지 않게)
          if (isCurrent()) await uploadPicture(object, picture, payload, isCurrent,
            layered ? { [LAYER_ENT]: undefined, ...(gone ? { [LAYER_MARK]: undefined } : {}) } : undefined);
          return;
        }
        let payload = picture.imageType === 'svg' ?
          await resizedSvg(picture, size) : await resizedPng(picture, size);
        // 비트맵 레이어 모양은 합친 PNG만 올리면 새 파일에 레이어 원본(SVG)이 없어 레이어가 사라졌다(검토로 찾음 2026-10-16) — 같이 올린다
        if (layered && picture.imageType === 'png') {
          let gone = false;
          try { payload = await withLayerOriginal(picture, payload, payload.shift); }
          catch (error) { if (!error.missing) throw error; gone = true; }
          if (!isCurrent()) return;
          await uploadPicture(object, picture, payload, isCurrent, { [LAYER_ENT]: undefined, ...(gone ? { [LAYER_MARK]: undefined } : {}) });
          return;
        }
        if (!isCurrent()) return;
        if (pixelVector(picture)) {
          await uploadPicture(object, picture, payload, isCurrent, { entryVectorPixel: 1, [PIXEL_VECTOR]: 'svg' });
          await repixelVector(object, picture.id, entryBitmapSvgArt(payload.svg));
        } else await uploadPicture(object, picture, payload, isCurrent);
      } catch (error) {
        console.warn('[entry-vector-rig] 공통 상자 맞추기 실패', picture.name, error);
      }
    });
    unifyRunning++;
    runLimited(tasks, 6).finally(() => { unifyRunning--; });
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
  async function pixelArtOf(picture, attempt = 0) {
    const k = pixelOf(picture) || 1;
    const load = async src => attempt ? loadImage(await freshImageUrl(src)) : loadImage(src); // 다시 받기는 캐시 없이
    let image;
    try {
      if (!picture.filename) throw Error('파일 이름 없음');
      image = await load(runtimePng(picture.filename));
    } catch { image = await load(window.Entry.playground.painter.getImageSrc(picture)); }
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
    // 엔트리는 번호(id) 없는 모양이면(오브젝트가 하나도 없을 때 — injectPicture가 빈 pictureSelected를 냄) addPicture를 거치지 않고 그림판만
    // 비운다(entry.min.js afterModified). 그 사이 확장이 받던 앞 모양 그림이 그 뒤에 와서 빈 그림판에 들어갔다(10-19 시험: 오브젝트를 모두 지우면
    // 지운 오브젝트 그림이 남음 — 엔트리만으로도 같음). 받던 표식을 새로 바꿔 늦게 온 그림을 버리고 불러오는 중 상태를 푼다.
    if (typeof proto.afterModified === 'function') {
      const afterModified = proto.afterModified;
      proto.afterModified = function (picture, ...rest) {
        if (!picture?.id) {
          try {
            this.__evrLoadToken = {};
            this.__evrLoading = null;
            clearTimeout(this.__evrLoadingTimer); clearTimeout(this.__evrLoadingSlowTimer);
            showLoadingCover(this, false);
          } catch (error) { console.warn('[entry-vector-rig] 번호 없는 모양', error); }
        }
        return afterModified.call(this, picture, ...rest);
      };
    }
    proto.addPicture = function (picture = {}, isImport, ...rest) {
      // 모양 바꾸기(afterModified)만 두 번째 인자가 참이다. 다른 호출은 엔트리 그대로 둔다.
      if (!isImport) return original.call(this, picture, isImport, ...rest);
      const token = {};
      const attempt = this.__evrRetryNext?.picture === picture ? this.__evrRetryNext.attempt : 0;
      this.__evrRetryNext = null;
      this.__evrLoadToken = token;
      this.__evrUnbaked = null;
      // 다시 받기 = 같은 모양을 처음부터 다시(새 표식 — 늦게 온 앞 결과는 버림, 캐시 없이 새로 받음). 그 사이 다른 모양을 골랐으면
      // 아무것도 안 한다 — 모양을 바꾼 직후 남은 앞 모양 단추를 누르면 새로 고른 모양이 버려지고 앞 모양 그림이 그 편집기에 들어갔다(검토 M, 시험 재현)
      const retry = () => {
        if (this.__evrLoadToken !== token || this.file?.id !== picture.id) return;
        this.__evrRetryNext = { picture, attempt: attempt + 1 };
        this.addPicture(picture, true);
      };
      startLoading(this, token, retry);
      const hand = ready => {
        if (this.__evrLoadToken !== token) return; // 그 사이 다른 모양을 골랐다: 이 그림은 버린다
        // 넘긴 뒤에는 엔트리가 넣고 5초 안에 덮개를 걷으므로(waitImported) [다시 받기]를 띄우지 않는다 — 넣는 중에 누르면 두 번 넣다가 앞 넣기의
        // 끝 알림에 덮개가 일찍 걷히고 그 사이 그린 것이 지워질 수 있었다(검토 M)
        clearTimeout(this.__evrLoadingSlowTimer);
        if (document.querySelector('.evr-load-cover[data-slow]')) showLoadingCover(this, true);
        if (ready !== picture && pixelOf(picture)) this.__evrUnbaked = picture.id;
        // 비트맵 레이어 목록: 엔트리는 다른 모양을 열어도 그림 층 data를 지우지 않으므로 여기서 비우고, 레이어 모양이면 엔트리가 첫
        // 그림을 넣는 순간(hookLayerPaint) 넣는다 — 그래야 엔트리 첫 되돌리기 기록에 같이 남는다
        try {
          const layer = this.entryPaint && paintLayer(this.entryPaint)?.layer;
          if (layer) delete layer.data[LAYERS];
          layerUi.importing = { token, meta: ready?.__evrLayers || null };
          layerUi.signature = null;
        } catch (error) { console.warn('[entry-vector-rig] 레이어 목록 비우기', error); }
        try {
          original.call(this, ready, isImport, ...rest);
        } finally {
          waitImported(this, token); // 엔트리 쪽에서 예외가 나도 5초 안에는 저장 막힘을 푼다
        }
      };
      readyPicture(this, picture, attempt).then(hand, error => {
        console.warn('[entry-vector-rig] 모양 그림 미리 받기 실패', picture.name, error);
        // 다시 받기가 실패하면(연결 끊김 등) 엔트리에 넘기지 않고 바로 알림·[다시 받기]를 다시 띄운다 — 넘기면 엔트리가 멈춘 첫 요청에 붙거나
        // 실패하고(엔트리는 실패 때 그림을 지우지 않음) 5초 뒤 덮개가 걷혀 앞 모양 그림이 새 모양 편집기에 남았다(검토 N, 시험 재현). 저장 막힘도 그대로.
        // 처음 받기(attempt 0)는 예전처럼 엔트리가 직접 받게 넘긴다(미리 받기만 안 되는 그림 — 벡터 픽셀 원래 SVG 등)
        if (attempt > 0) {
          if (this.__evrLoadToken === token) {
            clearTimeout(this.__evrLoadingTimer); clearTimeout(this.__evrLoadingSlowTimer); // 0.15초 안에 실패하면 보통 덮개 타이머가 알림을 덮어썼음(시험)
            showLoadingCover(this, true, retry, error?.status ? `모양 그림을 서버에서 받지 못했습니다(${error.status}) — 잠시 뒤 다시 받거나, 다른 모양을 골랐다 돌아오거나, 새로고침해 보세요.` : null);
          }
          return;
        }
        // 벡터 픽셀 모양의 모양 주소는 실행 화면용 아틀라스 칸(시트 전체 SVG)이라 그대로 넘기면 시트가 벡터 그림으로 열린다 —
        // 원래 SVG 주소를 넘겨 엔트리가 직접 받게 한다
        hand(pixelVector(picture) ? { ...picture, imageType: 'svg', fileurl: vectorSource(picture) } : picture);
      });
    };
  }
  // SVG는 글로 받아 넘긴다. paper importSVG는 첫 줄에 '<'가 있는 글을 바로 읽는다(주소면 다시 받는다).
  async function svgText(src, attempt = 0) {
    const response = await fetch(src, fetchOptions(attempt));
    if (!response.ok) throw Object.assign(Error(`SVG를 받을 수 없습니다 (${response.status})`), { status: response.status });
    const text = (await response.text()).replace(/^\s+/, '');
    if (!/^[^\n]*</.test(text)) throw Error('SVG 글이 아닙니다.');
    return text;
  }
  // ---- 벡터 SVG 정의 이름 겹침(1.3) ----
  // 엔트리 저장(entry-paint exportSVG)은 그림 층 도형마다 따로 만든 SVG를 이어 붙여서, 그라데이션·클리핑 틀 같은 정의 이름이 도형마다
  // 처음부터 다시 매겨진다(color-1, clip-1…). 다시 열면(importSVG) 겹친 이름이 모두 마지막 정의를 가리켜 그라데이션이 바뀌고 두 번째
  // 클리핑 마스크부터 사라진다 — 엔트리 결함(확장 없이도 같음, 10-18 실험 vector-roundtrip). 이름이 겹칠 때만 도형 SVG(맨 위 svg의
  // 자식 svg)마다 그 안 정의 이름과 그 안 참조(url(#…)·href="#…")를 고유하게 바꾼다. 저장할 때 고쳐 서버 파일이 바르게 남고, 열 때도
  // 고쳐 예전에 저장된 파일도 바르게 열린다. 고치다 실패하면 원래 글을 그대로 쓴다.
  function uniqueSvgIds(text) {
    if (typeof text !== 'string' || !text.includes(' id="')) return text;
    const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    if (new Set(ids).size === ids.length) return text;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'svg' || doc.querySelector('parsererror')) return text;
    const blocks = [...root.children].filter(element => element.nodeName === 'svg');
    if (blocks.length < 2) return text;
    blocks.forEach((block, k) => {
      const rename = new Map();
      for (const element of block.querySelectorAll('[id]')) {
        const id = element.getAttribute('id'), next = `${id}-evr${k}`;
        rename.set(id, next);
        element.setAttribute('id', next);
      }
      if (!rename.size) return;
      for (const element of [block, ...block.querySelectorAll('*')]) {
        for (const attr of [...element.attributes]) {
          let value = attr.value, changed = false;
          if (value.includes('url(#')) value = value.replace(/url\(#([^)\s]+)\)/g, (all, id) => rename.has(id) ? (changed = true, `url(#${rename.get(id)})`) : all);
          if (/^(xlink:)?href$/.test(attr.name) && value.startsWith('#') && rename.has(value.slice(1))) { value = `#${rename.get(value.slice(1))}`; changed = true; }
          if (changed) element.setAttributeNS(attr.namespaceURI, attr.name, value);
        }
      }
    });
    const out = new XMLSerializer().serializeToString(doc);
    return text.startsWith('<?xml') && !out.startsWith('<?xml') ? `<?xml version="1.0" encoding="utf-8"?>\n${out}` : out;
  }
  const svgIdFixed = new WeakSet();
  // 엔트리는 모양 탭을 처음 열 때 그림판을 만들고(painter.initialize → EntryPaint.default.create) 곧바로 첫 그림을 연다 — 0.5초 점검에서
  // 그림판이 생긴 뒤 감싸면 첫 그림은 안 고친 채 열렸다(독립 검토 지적). 그림판 클래스(window.EntryPaint.default)의 공용 틀을 미리 감싼다.
  function ensureSvgIdFix(painter) {
    const ep = painter?.entryPaint;
    hookSvgIdProto(window.EntryPaint?.default?.prototype);
    if (ep) hookSvgIdProto(Object.getPrototypeOf(ep));
    // paper 틀은 그림판이 생기기 전에도 건다(첫 그림을 열며 옮길 때부터 따라가게) — 그림판 클래스의 paper는 모듈을 그대로 돌려주는 읽기 전용 값
    let P = ep?.paper;
    if (!P) try { P = window.EntryPaint?.default?.prototype?.paper; } catch { P = null; }
    if (P?.Item) { hookGradientSvgSpace(P); hookMaskStyleTransform(P); }
  }
  function hookSvgIdProto(proto) {
    if (!proto || svgIdFixed.has(proto) || typeof proto.exportSVG !== 'function' || typeof proto.addSVG !== 'function') return;
    svgIdFixed.add(proto);
    const exportSVG = proto.exportSVG, addSVG = proto.addSVG;
    const fixed = (text, when) => {
      try { return uniqueSvgIds(text); } catch (error) { console.warn(`[entry-vector-rig] SVG 이름 겹침 고치기(${when})`, error); return text; }
    };
    proto.exportSVG = function (...args) { return fixed(exportSVG.apply(this, args), '저장'); };
    proto.addSVG = function (source, ...rest) {
      if (typeof source === 'string' && /^\s*</.test(source)) return addSVG.call(this, fixed(source, '열기'), ...rest);
      // 주소로 넣는 길(모양 가져오기 등): 글로 받아 고친 뒤 넣는다(엔트리도 주소면 비동기로 받는다). 못 받으면 엔트리 그대로.
      if (typeof source === 'string' && /\.svg(\?|#|$)/i.test(source)) {
        // 받는 사이 다른 모양을 열었으면 넣지 않는다(늦게 온 그림이 다른 모양 그림 층에 섞이지 않게 — 검토 지적)
        const painter = window.Entry?.playground?.painter, token = painter?.__evrLoadToken, fileId = painter?.file?.id;
        const still = () => !painter || (painter.__evrLoadToken === token && painter.file?.id === fileId);
        fetch(source, { credentials: 'same-origin' })
          .then(response => response.ok ? response.text() : Promise.reject(Error(`SVG를 받을 수 없습니다 (${response.status})`)))
          .then(text => { if (still()) addSVG.call(this, fixed(text.replace(/^\s+/, ''), '열기'), ...rest); },
            () => { if (still()) addSVG.call(this, source, ...rest); });
        return undefined;
      }
      return addSVG.call(this, source, ...rest);
    };
    proto.exportSVG.__evrSvgIds = proto.addSVG.__evrSvgIds = true; // 시험이 미리 감쌌는지 본다(vector-roundtrip)
  }
  // 그라데이션 점 자리: paper 편집기는 항목의 부모 좌표로 그리지만(Color#toCanvasStyle이 항목 행렬을 거꾸로 건다 — 검토 L, 엔트리 번들 paper
  // 확인), 저장 SVG(gradientUnits=userSpaceOnUse)는 그 요소의 좌표계로 읽는다. paper SVG 내보내기는 도형(Shape)·글상자·그림은 회전·늘리기만
  // transform에 쓰고 이동은 x·y로(getTransform(matrix, true)), 경로는 행렬 전체를 transform에 쓰므로, 항목을 SVG로 쓰는 순간에만 점을 그
  // 좌표계로 바꿔 쓰고 되돌린다(엔트리 저장은 맨 위 항목 사본을 옮긴 뒤 항목마다 exportSVG — 옮길 때 paper가 점도 같이 옮기므로 이 순간이어야
  // 맞음). 열 때는 paper가 fill을 먼저 넣고 transform을 걸며 점도 같이 옮겨(번들 확인) 따로 할 일이 없다. 예전엔 돌린 도형의 그라데이션이 저장
  // SVG·다시 연 편집기에서 다른 자리였다(시험: 브라우저가 그린 저장 SVG가 한 색).
  function hookGradientSvgSpace(P) {
    const proto = P?.Item?.prototype;
    if (!proto || own(proto, '__evrGradientSpace') || typeof proto.exportSVG !== 'function') return;
    Object.defineProperty(proto, '__evrGradientSpace', { value: true });
    const exportSVG = proto.exportSVG;
    proto.exportSVG = function (...args) {
      const kept = [];
      try {
        for (const item of [this, ...(typeof this.getItems === 'function' ? this.getItems({}) : [])]) {
          const m = item.matrix;
          // 겹친 경로(CompoundPath)는 자식이 있어도 자기 칠을 <path transform=행렬 전체> 한 요소로 쓴다(검토 M)
          if ((item.children && item.className !== 'CompoundPath') || !m || m.isIdentity()) continue;
          const own = /^(Shape|PointText|Raster)$/.test(item.className) ? new P.Matrix(m.a, m.b, m.c, m.d, 0, 0) : m;
          const back = own.inverted();
          if (!back) continue;
          for (const key of ['fillColor', 'strokeColor']) {
            const color = item[key];
            if (!color?.gradient) continue;
            kept.push([item, key, color]);
            // 색 복사(new Color(색))는 점을 복제하고 투명도를 지키며 그라데이션 주인 목록에 끼지 않는다(번들 확인) — 예전처럼 새로 만들면 색의
            // 투명도를 버리고 저장할 때마다 같이 쓰는 그라데이션의 주인 목록이 쌓였다(검토 M)
            const moved = new P.Color(color);
            moved.transform(back);
            item[key] = moved;
          }
        }
      } catch (error) { console.warn('[entry-vector-rig] 그라데이션 점 바꿔 쓰기', error); }
      try { return exportSVG.apply(this, args); } finally { for (const [item, key, color] of kept) item[key] = color; }
    };
  }
  // 마스크 틀에 적어 둔 그라데이션 점(data.evrMaskStyle)도 항목과 같이 옮긴다. paper Item#transform은 살아 있는 칠의 그라데이션 점만 같은
  // 행렬로 옮기고(번들 확인) data에 적은 점은 그대로 둬서, 마스크를 만든 뒤 묶음을 옮기거나 돌리고 [마스크 풀기]를 하면 그라데이션이 옮기기 전
  // 자리에 칠해졌다(검토 M, 시험 재현). paper가 칠을 옮기는 때(행렬이 있을 때)·같은 항목(도형·겹친 경로 — 묶음에 적힌 색은 자식 좌표라 자식이
  // 따로 옮김)에만 같은 행렬로 옮긴 새 기록으로 바꾼다(복제본과 기록을 같이 쓰므로 제자리에서 고치지 않음). 열 때는 data가 transform 뒤에
  // 들어가 두 번 옮기지 않는다(검토 M 번들 확인).
  function hookMaskStyleTransform(P) {
    const proto = P?.Item?.prototype;
    if (!proto || own(proto, '__evrMaskStyleMove') || typeof proto.transform !== 'function') return;
    Object.defineProperty(proto, '__evrMaskStyleMove', { value: true });
    const transform = proto.transform;
    proto.transform = function (matrix, ...rest) {
      const result = transform.call(this, matrix, ...rest);
      const style = this._data?.evrMaskStyle;
      if (style && matrix && !matrix.isIdentity() && (!this._children || this.className === 'CompoundPath')) {
        try {
          const at = point => {
            if (!Array.isArray(point)) return point;
            const moved = matrix.transform(new P.Point(point[0], point[1]));
            return [moved.x, moved.y];
          };
          const move = value => !value || typeof value === 'string' || !value.gradient ? value
            : { ...value, origin: at(value.origin), destination: at(value.destination), highlight: at(value.highlight) };
          this._data.evrMaskStyle = { ...style, fill: move(style.fill), stroke: move(style.stroke) };
        } catch (error) { console.warn('[entry-vector-rig] 마스크 틀 그라데이션 점 옮기기', error); }
      }
      return result;
    };
  }
  // [다시 받기](attempt 1부터)는 같은 주소를 캐시 없이 새로 받는다(fetch cache:'no-store') — 크롬은 받는 중인 같은 주소 그림(new Image)을 새로
  // 받지 않고 그 요청을 같이 기다리게 해, 멈춘 주소를 다시 받으면 요청이 하나도 안 나가고 같이 멈췄다(검토 M, 시험 재현). 받은 그림은 data 주소로
  // 넘긴다(픽셀 모양처럼). 처음엔 주소에 꼬리표(?evr-retry=n)를 붙였는데, 서버가 모르는 꼬리표를 받아 주는지는 엔트리 /lib만 확인했고 사용자
  // 그림 서버는 확인하지 못해 그만뒀다(검토 O — 거절하면 다시 받기가 매번 실패).
  function fetchOptions(attempt) {
    return { credentials: 'same-origin', ...(attempt ? { cache: 'no-store' } : {}) };
  }
  async function freshImageUrl(src) {
    const response = await fetch(src, fetchOptions(1));
    if (!response.ok) throw Object.assign(Error(`그림을 받을 수 없습니다 (${response.status})`), { status: response.status });
    const blob = await response.blob();
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || Error('그림을 읽을 수 없습니다.'));
      reader.readAsDataURL(blob);
    });
    await loadImage(url); // 그림인지 확인
    return url;
  }
  // 엔트리에 넘길 모양: 그림을 미리 받아 두고, 받은 그림을 바로 쓰도록 주소를 바꾼 사본(원래 모양은 그대로).
  async function readyPicture(painter, picture, attempt = 0) {
    const k = pixelOf(picture);
    // 비트맵 레이어 모양: 저장 SVG에서 레이어를 꺼내 지금 레이어 그림을 비트맵으로 넘긴다(실패하면 아래 원래 길 — 합친 그림)
    if (picture.dimension?.[LAYER_MARK] && picture.filename && !(k > 1)) {
      try {
        const response = await fetch(svgFile(picture.filename), fetchOptions(attempt));
        const carried = picture.dimension[LAYER_ENT];
        if (!response.ok && !carried) throw Error(`레이어 SVG를 받을 수 없습니다 (${response.status})`);
        const text = response.ok ? await response.text() : entLayerSvgText(carried);
        const read = await readLayerSvg(text, painter.entryPaint, picture.dimension[BITMAP_RIG]);
        if (read) return { ...picture, imageType: 'png', fileurl: read.frame.toDataURL('image/png'), __evrLayers: read.meta };
      } catch (error) { console.warn('[entry-vector-rig] 레이어 모양 열기 실패 — 합친 그림으로 엽니다', picture.name, error); }
    }
    // 벡터 픽셀 모양은 원래 SVG(벡터)로 연다 — 실행 화면용 아틀라스 칸(fileurl)이 아니라
    if (pixelVector(picture)) {
      const source = picture.filename ? svgFile(picture.filename) : atlasOf(picture)?.base;
      if (source) return { ...picture, imageType: 'svg', fileurl: await svgText(source, attempt) };
    }
    // 픽셀 모양(SVG·아틀라스 주소)도 비트맵으로, 원래 해상도 그림을 넣어 연다.
    if (k > 1) {
      const art = await pixelArtOf(picture, attempt);
      return { ...picture, imageType: 'png', fileurl: art.toDataURL('image/png') };
    }
    if (k === 1 && picture.filename) {
      const src = runtimePng(picture.filename); // 1배 픽셀 모양은 파일 PNG가 원래 그림이다
      if (attempt) return { ...picture, imageType: 'png', fileurl: await freshImageUrl(src) };
      await loadImage(src, true);
      return { ...picture, imageType: 'png', fileurl: src };
    }
    const src = painter.getImageSrc(picture);
    if (picture.imageType === 'svg') return { ...picture, fileurl: await svgText(src, attempt) };
    if (attempt) return { ...picture, fileurl: await freshImageUrl(src) }; // 다시 받기: 받은 그림을 data 주소로
    await loadImage(src, true); // 엔트리가 같은 주소를 다시 받을 때 캐시에서 온다
    return picture;
  }
  // 불러오는 동안은 저장을 막고, 0.15초 넘게 걸리면 편집기를 덮어 그리기도 막는다. 10초 넘게 걸리면(그림 받기가 멈춤 — 네트워크) 덮개에
  // 알림과 [다시 받기]를 둔다: 예전엔 받기가 끝날 때까지 덮개만 남아 그림판을 못 썼다(시험 환경에서 60초 넘게 재현). 덮개를 그냥 걷지는
  // 않는다 — 그림이 오기 전에 그리면 늦게 온 그림이 덮어쓰거나, 레이어 모양이 합친 그림으로 열려 저장 때 레이어가 사라질 수 있다.
  const LOAD_SLOW_MS = 10000;
  function startLoading(painter, token, retry) {
    painter.__evrLoading = token;
    clearTimeout(painter.__evrLoadingTimer);
    clearTimeout(painter.__evrLoadingSlowTimer);
    // 앞 모양의 알림·[다시 받기]가 떠 있으면 바로 보통 덮개로(150ms 뒤가 아니라 — 그 사이 누를 수 있었음, 검토 M)
    if (document.querySelector('.evr-load-cover[data-slow]')) showLoadingCover(painter, true);
    painter.__evrLoadingTimer = setTimeout(() => {
      if (painter.__evrLoading === token) showLoadingCover(painter, true);
    }, 150);
    painter.__evrLoadingSlowTimer = setTimeout(() => {
      if (painter.__evrLoading === token) showLoadingCover(painter, true, retry);
    }, LOAD_SLOW_MS);
  }
  // 엔트리는 그림을 다 넣은 뒤 saveSnapshot → SNAPSHOT_SAVED를 낸다. 오지 않으면(그림 오류 등) 5초 뒤 푼다.
  function waitImported(painter, token) {
    const finish = () => {
      if (painter.__evrLoading !== token) return;
      painter.__evrLoading = null;
      clearTimeout(painter.__evrLoadingTimer);
      clearTimeout(painter.__evrLoadingSlowTimer);
      showLoadingCover(painter, false);
    };
    painter.entryPaint?.once?.('SNAPSHOT_SAVED', finish);
    setTimeout(finish, 5000);
  }
  function showLoadingCover(painter, on, retry, message) {
    const area = painter.entryPaint?.project?.view?.element?.closest?.('.canvas_area');
    let cover = document.querySelector('.evr-load-cover');
    if (!on || !area) { cover?.remove(); return; }
    if (!cover) {
      cover = document.createElement('div');
      cover.className = 'evr-load-cover';
    }
    cover.replaceChildren();
    if (retry) {
      cover.dataset.slow = 'true';
      const text = document.createElement('span');
      text.textContent = message || '모양 그림을 받는 데 오래 걸립니다 — 인터넷 연결을 확인한 뒤 다시 받아 보세요.';
      cover.append(text, button('다시 받기', () => { try { retry(); } catch (error) { console.warn('[entry-vector-rig] 모양 다시 받기', error); } },
        { class: 'evr-layers-act evr-load-retry', title: '이 모양 그림을 처음부터 다시 받습니다' }));
    } else {
      delete cover.dataset.slow;
      cover.textContent = '모양 그림을 불러오는 중…';
    }
    if (cover.parentElement !== area) area.append(cover);
  }
  // 엔트리가 작품을 불러오는 중인가. 엔트리 사이트는 .ent를 넣은 뒤 다른 정리를 기다렸다가 Entry.Loader.isLoaded()를 보고, 아직이면
  // loadComplete를 기다려 진행 창("업로드 중이에요.")을 닫는다. 그런데 엔트리는 loadComplete를 작품마다 한 번만 보내서, 그 사이 확장이
  // 모양 그림을 다시 불러(setImage) 대기열에 넣으면 창이 영영 안 닫혔다(2026-10-15 재현, 애니메이터만 켜고 약 3번에 1번). 그래서 진행 창이
  // 떠 있거나 불러오는 중에는 작품을 연 뒤 모양을 바꾸는 자동 정리(주소 다시 걸기·자기 파일·.ent 레이어)를 다음 번으로 미룬다.
  function entryLoading() {
    const loader = window.Entry?.Loader;
    if (typeof loader?.isLoaded === 'function' && !loader.isLoaded()) return true;
    return [...document.querySelectorAll('[class*="modal_progress"]')].some(element => element.getClientRects().length);
  }
  // .ent를 다시 열면 엔트리 서버가 fileurl을 빼고 돌려준다. SVG로 저장한 픽셀 모양은 새 파일
  // 이름으로도 서버에 SVG가 남아 있으므로(시험으로 확인) 주소만 다시 건다. 업로드는 하지 않고,
  // 확인 요청도 한 번에 2개까지만 보낸다.
  const svgChecks = new Map();
  let svgChecking = 0;
  // 아틀라스 칸을 쓰는 모양(imageType png)도 같은 방법으로 칸 주소를 다시 건다(아틀라스 파일로 확인).
  function restorePixelFileurls() {
    if (entryLoading()) return;
    for (const object of window.Entry?.container?.getAllObjects?.() || []) {
      for (const picture of object.pictures || []) {
        const atlas = pixelOf(picture) ? atlasOf(picture) : null;
        let file, url;
        if (atlas) {
          ({ file } = atlas); url = atlasUrl(atlas);
          if (picture.fileurl === url) continue;
        } else {
          if (!pixelOf(picture) || pixelVector(picture) || picture.imageType !== 'svg' || !picture.filename) continue;
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
    const next = { ...picture, imageType: pixelVector(picture) ? 'svg' : 'png', dimension: { ...picture.dimension } };
    const atlas = atlasOf(picture);
    if (atlas?.base) next.fileurl = atlas.base; else delete next.fileurl;
    delete next.dimension.entryVectorPixel;
    delete next.dimension.entryVectorAtlas;
    delete next.dimension[PIXEL_VECTOR];
    return next;
  }
  // 벡터 픽셀 모양의 실행 화면 칸을 지금 PNG(png: data URL, 없으면 서버의 모양 PNG)로 다시 올려 건다. 그 사이 다시 저장했거나
  // 지웠으면 건너뛴다(replacePictures). 실패하면 칸 없이 둔다 — 실행 화면은 보간된 PNG(옛 그림이 남지는 않음).
  // ---- 엔트리 비트맵 전환과 같은 그림(벡터 픽셀 아트 결과) ----
  // 같은 모양이면 벡터 픽셀 아트 결과 = 비트맵 픽셀 아트 결과여야 한다(사용자 요구 — 비트맵 쪽은 바꾸지 않고 벡터 결과를 맞춤).
  // 비트맵 모양의 그림은 엔트리가 벡터를 비트맵으로 바꿀 때 만든 것이므로, 그와 똑같이 굽는다(entry-paint 260921 Lr → jr):
  // 그림 층 맨 위 항목마다, 경로·복합 경로·글자는 칠(선 굵기 0)과 선(칠 없음)을 따로 72dpi로 굽고 알파 128 기준으로 끊어 칠·선
  // 색으로 칠한 뒤(getAliasingRaster) 한 장으로, 그 밖(묶음·그림 등)은 통째로 굽는다(번짐 그대로). 그 조각을 차례로 겹친다.
  // 엔트리는 조각을 무대 밖에서 자르지만 여기서는 모양 범위 그대로 둔다. 기준점 상자(확장 표시)는 뺀다.
  // 예전(2026-10-14 오전)엔 실행 화면 PNG를 그대로 썼는데, 엔트리 기본 SVG는 크기가 없어 88×150으로 줄었고(모양은 144×246)
  // 맨 위 경로도 번짐이 남아 비트맵과 결과가 달랐다(사용자 지적).
  const ALIAS_ALPHA = 128;
  function aliasRaster(P, raster, color) {
    if (!raster?.width || !raster.height) return null;
    const image = raster.getImageData(new P.Rectangle(0, 0, raster.width, raster.height)), data = image.data;
    const rgb = [color.red, color.green, color.blue].map(value => Math.round(value * 255));
    for (let i = 3; i < data.length; i += 4) {
      data[i] = data[i] < ALIAS_ALPHA ? 0 : 255;
      data[i - 3] = rgb[0]; data[i - 2] = rgb[1]; data[i - 1] = rgb[2];
    }
    raster.setImageData(image, new P.Point(0, 0));
    return raster;
  }
  function entryBitmapPiece(P, item) {
    if (item instanceof P.Path || item instanceof P.CompoundPath || item instanceof P.PointText) {
      const parts = [];
      if (item.style.fillColor) {
        const fill = item.clone({ insert: false });
        fill.strokeWidth = 0;
        const raster = aliasRaster(P, fill.rasterize({ resolution: 72, insert: false }), item.style.fillColor);
        if (raster) parts.push(raster);
      }
      if (item.style.strokeColor) {
        const stroke = item.clone({ insert: false });
        stroke.style.fillColor = null;
        const raster = aliasRaster(P, stroke.rasterize({ resolution: 72, insert: false }), item.style.strokeColor);
        if (raster) parts.push(raster);
      }
      return parts.length ? new P.Group({ insert: false, children: parts }).rasterize({ resolution: 72, insert: false }) : null;
    }
    return item.rasterize({ resolution: 72, insert: false });
  }
  // items(그림 층 맨 위 항목, 그림 좌표)를 frame(그림 좌표 사각형) 크기 캔버스에
  function entryBitmapCanvas(P, items, frame) {
    const canvas = canvasOfSize(Math.max(1, Math.round(frame.width)), Math.max(1, Math.round(frame.height))), context = canvas.getContext('2d');
    for (const item of items) {
      if (item.data?.entryVectorCanvasBox === '1') continue;
      const raster = entryBitmapPiece(P, item);
      if (!raster?.width || !raster.height) continue;
      const b = raster.bounds;
      context.drawImage(raster.canvas, Math.round(b.x - frame.x), Math.round(b.y - frame.y));
    }
    return canvas;
  }
  // 엔트리가 SVG 모양을 열 때 그림 층 맨 위 항목이 되는 것(entry-paint 260921 sC·Un): 바깥 묶음을 풀고(틀 clipMask 빼고 묶음 행렬을
  // 자식에), 남은 것이 묶음 하나면 또 푼다
  function entryTopItems(P, root) {
    let items = [root];
    while (items.length === 1 && items[0] instanceof P.Group) {
      const group = items[0];
      items = group.children.filter(child => !child.clipMask);
      if (!group.matrix.isIdentity()) items.forEach(child => child.transform(group.matrix));
    }
    return items;
  }
  // 벡터 SVG 글 → 보이는 범위 크기(1단위 = 1px) 그림. paper importSVG는 SVG 좌표 그대로 읽는다(실험: 엔트리봇 기본 SVG viewBox 0 0 144 246).
  function entryBitmapSvgArt(text) {
    const P = window.Entry.playground.painter.entryPaint.paper;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    const view = doc.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    if (view?.length !== 4 || !view.every(Number.isFinite) || !(view[2] > 0 && view[3] > 0)) throw Error('viewBox가 없는 SVG입니다.');
    const root = P.project.importSVG(text, { insert: false });
    // 엔트리는 연 SVG를 화면 가운데(처음 중심 home)로 옮긴 뒤 굽는다(lC: position = view.center). 같은 좌표에서 구워야 번짐 경계 화소까지
    // 같다(SVG 좌표 그대로 구우면 엔트리봇에서 1화소 색이 달랐다 — 시험으로 찾음).
    const home = areaHome(window.Entry.playground.painter.entryPaint);
    root.position = new P.Point(home.x, home.y);
    const frame = root.bounds.clone();
    return entryBitmapCanvas(P, entryTopItems(P, root), frame);
  }
  // 벡터 모양의 원래 SVG 주소(벡터 픽셀 모양은 모양 주소가 아틀라스 칸이라 따로)
  const vectorSource = picture => picture.filename ? svgFile(picture.filename) :
    atlasOf(picture)?.base || window.Entry.playground.painter.getImageSrc(picture);
  // ---- 자기 파일 없는 모양(엔트리 라이브러리 그림) ----
  // 엔트리 라이브러리 그림(엔트리봇 등)은 파일 이름 없이 fileurl(/lib/… 주소)만으로 그림을 찾는다(entry.min.js 260921 _getImageSrc:
  // fileurl이 없으면 filename으로 만든 PNG 주소). 픽셀 아트가 그 fileurl을 아틀라스 칸(/uploads/…#f번호)으로 바꾸면 그 모양의 그림 단서가
  // 서버 파일 주소 하나뿐인데, 엔트리 서버는 .ent로 묶었다 다시 풀 때 /uploads/ fileurl을 지운다(실험 2026-10-14, 로그인 없이: /lib/ 주소는
  // 남기고 /uploads/ 주소는 #이 있든 없든 지움). 그래서 불러온 작품에서 그 모양은 그림 단서가 하나도 없어 엔트리가 작품 전체 불러오기를
  // 멈췄다(filename.substring 오류, 오브젝트 0개 — 확장이 있든 없든 같음). 확장이 fileurl을 바꾸기 전에 모양에 자기 파일을 만든다:
  // 원래 그림 그대로 SVG(+엔트리 저장처럼 같은 크기 PNG)·PNG로 올린다. 칸 주소가 빠져도 파일 이름으로 그림이 남는다(실행 화면은 보통
  // 그림, 확장이 켜지면 칸 주소를 다시 건다). 원래 주소를 알 수 없으면(lasting) 다시 시도하지 않는다.
  async function ownPictureFile(picture) {
    const atlas = atlasOf(picture);
    const source = atlas?.base || (picture.fileurl && (!atlas || picture.fileurl !== atlasUrl(atlas)) ? picture.fileurl : null);
    if (!source) throw Object.assign(Error('원래 그림 주소가 없는 모양입니다.'), { lasting: true });
    // 원래 그림은 엔트리 자기 출처(라이브러리 /lib/·업로드 /uploads/)에서만 받아 다시 올린다. 남이 만든 작품을 열기만 해도 도는 길이라
    // (ownPixelPictures), 작품에 적힌 다른 출처 주소의 SVG를 사용자 업로드 공간에 그대로 다시 올리지 않게 한다.
    if (new URL(source, location.href).origin !== location.origin)
      throw Object.assign(Error('엔트리 밖 주소의 그림입니다.'), { lasting: true });
    if (picture.imageType === 'svg') {
      const svg = await svgText(source);
      const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      const view = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
      if (root.nodeName !== 'svg' || view?.length !== 4 || !view.every(Number.isFinite) || !(view[2] > 0 && view[3] > 0))
        throw Object.assign(Error('viewBox가 없는 SVG입니다.'), { lasting: true });
      const canvas = await renderSvg(root, view[2], view[3]);
      return uploadPayload({ ext: 'svg', svg, image: canvas.toDataURL('image/png'), size: { width: canvas.width, height: canvas.height } });
    }
    const canvas = canvasOfImage(await loadImage(source, true));
    return uploadPayload({ ext: 'png', image: canvas.toDataURL('image/png'), size: { width: canvas.width, height: canvas.height } });
  }
  // 이미 그렇게 된 모양(이전 버전의 픽셀 아트)도 주기 갱신에서 자기 파일을 만들어 준다. 작품에 남기려면 작품을 저장해야 한다
  // (.ent 내려받기는 지금 상태를 보내므로 바로 반영된다).
  // 한 번에 2개까지만(그림 그리기·올리기가 다른 업로드를 밀어내지 않게).
  const ownJobs = new Set(), ownFailed = new Map(), OWN_SLOTS = 2; // ownFailed: 모양 id → 다시 시도할 때
  function ownPixelPictures() {
    // 다른 일괄 작업(픽셀 켜기·끄기, 맞추기, 공통 크기)이 도는 동안은 미룬다 — 그 작업이 같은 모양을 바꾸는 중일 수 있다
    if (pixelBusy || alignBusy || unifyRunning || entryLoading()) return;
    const painter = window.Entry?.playground?.painter;
    for (const object of window.Entry?.container?.getAllObjects?.() || []) {
      for (const picture of object.pictures || []) {
        if (ownJobs.size >= OWN_SLOTS) return;
        if (picture.filename || !pixelOf(picture) || ownJobs.has(picture.id) || Date.now() < (ownFailed.get(picture.id) || 0)) continue;
        // 저장 중이거나 고치는 중인 모양은 건너뛴다(settleSave는 파일 이름이 바뀐 것을 엔트리 저장이 끝난 것으로 본다)
        if (pendingSaves.some(record => record.pictureId === picture.id) ||
            (painter?.file?.id === picture.id && painter.file.modified)) continue;
        ownJobs.add(picture.id);
        ownPictureFile(picture)
          .then(saved => replacePictures(object, [picture], current => ({ ...current, filename: saved.filename })))
          .catch(error => {
            // 원래 주소를 알 수 없거나 서버가 받지 않는 요청(4xx, 429 빼고)은 이 세션에서 다시 시도하지 않는다
            const lasting = error.lasting || (error.status >= 400 && error.status < 500 && error.status !== 429);
            ownFailed.set(picture.id, lasting ? Infinity : Date.now() + 30000);
            console.warn('[entry-vector-rig] 모양 자기 파일 만들기 실패', picture.name, error);
          })
          .finally(() => ownJobs.delete(picture.id));
      }
    }
  }
  // 아틀라스 칸 전의 fileurl(원래 주소). 이미 칸이면 그 칸이 처음 기억한 원래 주소를 잇는다. 자기 파일이 있는 모양은 원래 주소를
  // 새로 기억하지 않는다(다시 저장한 그림을 끌 때 옛 라이브러리 그림으로 돌아가지 않게).
  function atlasBase(picture) {
    const atlas = atlasOf(picture);
    if (atlas?.base) return atlas.base;
    if (picture.filename || !picture.fileurl || (atlas && picture.fileurl === atlasUrl(atlas))) return undefined;
    return picture.fileurl;
  }
  // 벡터 픽셀 모양의 실행 화면 칸을 다시 올려 건다. art(캔버스)가 없으면 원래 SVG를 받아 번짐 없는 화소로 굽는다.
  // 파일 이름 없는 라이브러리 벡터(픽셀 오브젝트에 새로 들어온 것)는 칸 주소를 걸기 전에 자기 파일부터 만든다(ownPictureFile 설명).
  async function repixelVector(object, id, art) {
    const picture = object?.pictures?.find(item => item.id === id);
    if (!picture) return;
    try {
      const cell = art || entryBitmapSvgArt(await svgText(vectorSource(picture)));
      const filename = picture.filename || (await ownPictureFile(picture)).filename;
      const [mark] = await uploadAtlases([cell], 1);
      if (!objectPixel(object)) return; // 그 사이 픽셀 아트를 껐으면 이 모양만 픽셀로 되살리지 않는다
      replacePictures(object, [picture], current => {
        const base = atlasBase(current);
        return { ...current, filename, imageType: 'svg', fileurl: atlasUrl(mark),
          dimension: { ...current.dimension, entryVectorPixel: 1, [PIXEL_VECTOR]: 'svg', entryVectorAtlas: { ...mark, ...(base ? { base } : {}) } } };
      });
    } catch (error) { console.warn('[entry-vector-rig] 벡터 픽셀 칸 올리기 실패', picture.name, error); }
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
      // 벡터 모양은 엔트리가 함께 저장한 실행 화면 PNG(pixelArtOf, 1배)를 칸으로 쓰고 모양은 벡터(svg) 그대로 둔다
      const vectors = pictures.map(picture => picture.imageType === 'svg' && !pixelOf(picture));
      const arts = new Array(pictures.length), owned = new Array(pictures.length);
      let loaded = 0;
      await runLimited(pictures.map((picture, index) => async () => {
        arts[index] = vectors[index] ? entryBitmapSvgArt(await svgText(vectorSource(picture))) : canvasOfImage(await pictureImage(picture));
        // 파일 이름 없는 모양(라이브러리 그림)은 칸 주소를 걸기 전에 자기 파일을 만든다(ownPictureFile 설명)
        if (!picture.filename) owned[index] = (await ownPictureFile(picture)).filename;
        toast(`픽셀 아트로 바꾸는 중… 그림 불러오기 ${++loaded}/${pictures.length}`);
      }), 6);
      const marks = await uploadAtlases(arts, 1, (done, total) =>
        toast(`픽셀 아트로 바꾸는 중… SVG 올리기 ${done}/${total}`));
      const skipped = replacePictures(object, pictures, (picture, index) => ({ ...picture,
        ...(owned[index] ? { filename: owned[index] } : {}),
        fileurl: atlasUrl(marks[index]), dimension: { ...picture.dimension, entryVectorPixel: 1,
          ...(vectors[index] ? { [PIXEL_VECTOR]: 'svg' } : {}),
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
        if (k === 1 && picture.imageType === 'svg') { repixelVector(object, picture.id); continue; }
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
  // 오브젝트의 모양을 모두 원래 해상도로 불러와 그림 부분만 잘라 둔다. 벡터 모양은 SVG를 보이는 범위 1단위 = 1px로 그린 그림을 쓰고
  // (화소 자리 = SVG 좌표 - 보이는 범위 왼쪽 위), 적용할 때 SVG 보이는 범위를 옮겨 다시 올린다. 예전 k배 픽셀 오브젝트의 벡터 모양만 뺀다.
  // anchors[i]: 잘라 낸 그림 안에서 회전 중심이 될 점. 처음에는 지금 회전 중심(그림 가운데)이다.
  let alignBusy = false;
  async function loadPictureFrames(object, verb) {
    const painter = window.Entry.playground.painter;
    if (painter?.file?.modified && object.pictures.some(picture => picture.id === painter.file.id))
      throw Error('저장하지 않은 변경 사항이 있습니다. 모양을 먼저 저장하세요.');
    const isVector = picture => picture.imageType === 'svg' && (!pixelOf(picture) || pixelVector(picture));
    const legacy = objectPixel(object) > 1;
    const candidates = object.pictures.filter(picture => !(legacy && isVector(picture)));
    const arts = new Array(candidates.length), vectors = new Array(candidates.length);
    let loaded = 0;
    await runLimited(candidates.map((picture, index) => async () => {
      try {
        if (isVector(picture)) {
          const read = await readSvg(picture, { boxOptional: true });
          vectors[index] = read;
          arts[index] = await renderSvg(read.root, read.view[2], read.view[3]);
        } else arts[index] = pixelOf(picture) ? await pixelArtOf(picture) : canvasOfImage(await pictureImage(picture));
      } catch (error) {
        // 읽을 수 없는 벡터 모양(보이는 범위가 없는 SVG 등)은 맞추지 않는다
        if (!isVector(picture)) throw error;
        console.warn('[entry-vector-rig] 벡터 모양을 맞출 수 없어 뺍니다', picture.name, error);
      }
      toast(`${verb}… 그림 불러오기 ${++loaded}/${candidates.length}`);
    }), 6);
    const kept = candidates.map((picture, index) => index).filter(index => arts[index]);
    const pictures = kept.map(index => candidates[index]);
    if (pictures.length < 2) throw Error('맞출 모양이 두 개 이상 있어야 합니다.');
    arts.splice(0, arts.length, ...kept.map(index => arts[index]));
    const svgs = kept.map(index => vectors[index] || null);
    // 다 불러오면 진행 표시를 곧 지운다(예전엔 창이 뜬 뒤에도 "3/3"이 왼쪽 아래에 남았다).
    toast(`${verb}… 그림 ${pictures.length}개 불러옴`, 800);
    const items = arts.map(trimmedItem);
    const anchors = items.map((item, i) =>
      [Math.round(arts[i].width / 2 - item.rect.x), Math.round(arts[i].height / 2 - item.rect.y)]);
    return { pictures, arts, items, anchors, vectors: svgs, skippedVector: object.pictures.length - pictures.length };
  }
  // 기준점대로 모든 모양을 같은 크기 틀에 그려 indexes의 모양만 다시 올린다(PNG 10장씩, 픽셀 아트면 아틀라스도).
  // 틀 크기가 지금 모양 크기와 다른 모양은 indexes에 없어도 함께 올린다(모두 같은 크기를 쓰므로).
  // 한 번에 바꿔 끼우고 되돌리기 한 단계로 남긴다. 그 사이 다시 저장했거나 지운 모양은 건너뛴다.
  // beforeUpload(올릴 모양 번호들)가 거짓을 돌려주면 올리지 않고 null을 돌려준다.
  async function commitPictureFrames(object, frames, indexes, verb, beforeUpload) {
    const { pictures, arts, items, anchors, vectors = [] } = frames;
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
    const saved = (i, file) => { uploaded.set(i, file); toast(`${verb}… 올리기 ${++sent}/${list.length}`); };
    const vectorList = list.filter(i => vectors[i]);
    // 그림이 십자 기준으로 옮겨진 거리(잘라 낸 그림의 기준점이 틀 가운데에 옴). 레이어 원본·비트맵 뼈대 관절도 십자 기준이라 같이 옮긴다 —
    // 예전엔 PNG만 묶어 올려 비트맵 레이어 모양의 레이어가 사라지고, 관절은 옛 자리에 남았다(검토로 찾음 2026-10-16).
    const shiftOf = i => ({ x: arts[i].width / 2 - items[i].rect.x - anchors[i][0], y: arts[i].height / 2 - items[i].rect.y - anchors[i][1] });
    const layeredList = k ? [] : list.filter(i => !vectors[i] && pictures[i].dimension?.[LAYER_MARK]);
    const layeredSet = new Set(layeredList), lostLayers = new Set(), flattened = new Set();
    await uploadArts({ indexes: list.filter(i => !vectors[i] && !layeredSet.has(i)),
      artAt: i => scale > 1 ? scaledCanvas(frameOf(i), size.width, size.height) : frameOf(i),
      state: {}, onSaved: saved });
    // 비트맵 레이어 모양: 레이어 원본을 옮겨 PNG와 같은 요청으로 한 장씩(묶음 업로드는 PNG만 받음). 원본을 못 받으면 그 모양은 건너뜀
    await runLimited(layeredList.map(i => async () => {
      try {
        const plain = { ext: 'png', image: frameOf(i).toDataURL('image/png'), size };
        let payload;
        try { payload = await withLayerOriginal(pictures[i], plain, shiftOf(i)); }
        catch (error) {
          if (!error.missing) throw error;
          payload = plain; // 레이어 원본이 이미 없는 모양: 보통 그림으로 맞추고 표시를 지운다
          flattened.add(i);
        }
        saved(i, await uploadPayload(payload));
      } catch (error) {
        lostLayers.add(i);
        console.warn('[entry-vector-rig] 레이어 원본을 읽지 못해 이 모양은 그대로 둡니다', pictures[i].name, error);
      }
    }), UPLOAD_SLOTS);
    // 벡터 모양: 기준점(SVG 좌표)이 틀 가운데에 오게 보이는 범위를 옮긴 SVG(+PNG)를 한 장씩 올린다(SVG는 묶음 업로드가 느림)
    await runLimited(vectorList.map(i => async () => {
      const { view } = vectors[i], { x, y } = items[i].rect;
      const center = { x: view[0] + x + anchors[i][0], y: view[1] + y + anchors[i][1] };
      const { canvas, payload } = await alignedSvg(vectors[i], center, box);
      made.set(i, pixelVector(pictures[i]) ? entryBitmapSvgArt(payload.svg) : canvas);
      saved(i, await uploadPayload(payload));
    }), UPLOAD_SLOTS);
    let marks = null;
    if (k) {
      const atlasArts = [];
      for (const i of list) atlasArts[i] = frameOf(i);
      marks = await uploadAtlases(atlasArts, scale, (done, total) => toast(`${verb}… 픽셀 아트 SVG ${done}/${total}`));
    }
    const next = [];
    for (const i of list) {
      const picture = pictures[i], current = object.pictures.find(item => item.id === picture.id);
      if (lostLayers.has(i) || !uploaded.has(i)) continue;
      if (!current || pictureFile(current) !== pictureFile(picture) || current.fileurl !== picture.fileurl) continue;
      const dimension = { ...current.dimension, width: size.width, height: size.height,
        entryVectorNativeCanvas: true, entryVectorArt: { x: clean(Math.max(anchors[i][0], items[i].w - anchors[i][0])),
          y: clean(Math.max(anchors[i][1], items[i].h - anchors[i][1])) } };
      delete dimension.entryVectorPivot;
      delete dimension.entryVectorAtlas;
      if (marks) dimension.entryVectorAtlas = marks[i];
      if (!vectors[i]) {
        const shift = shiftOf(i);
        if (dimension[BITMAP_RIG]) {
          try {
            const rig = JSON.parse(dimension[BITMAP_RIG]);
            rig.joints = rig.joints.map(j => ({ ...j, x: clean(j.x + shift.x), y: clean(j.y + shift.y) }));
            dimension[BITMAP_RIG] = JSON.stringify(rig);
          } catch (error) { console.warn('[entry-vector-rig] 비트맵 뼈대 관절 옮기기', picture.name, error); }
        }
        if (layeredSet.has(i)) delete dimension[LAYER_ENT]; // 새 파일 SVG에 옮긴 레이어 원본이 있다(.ent용 담은 값은 옛 자리)
        if (flattened.has(i)) delete dimension[LAYER_MARK];
      }
      const result = { ...current, filename: uploaded.get(i).filename, imageType: vectors[i] ? 'svg' : 'png', dimension };
      delete result.thumbUrl;
      if (marks) result.fileurl = atlasUrl(marks[i]); else delete result.fileurl;
      next.push(result);
    }
    setPicturesBatch(object.id, next);
    return { done: next.length, skipped: list.length - next.length - lostLayers.size, keptLayers: lostLayers.size };
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
    section('모양').append(node('p', 'evr-slicer-note', `모양 ${count}개를 같은 크기로 다시 올립니다` +
      (frames.vectors.some(Boolean) ? ' · 벡터 모양은 도형은 그대로 두고 보이는 범위만 옮깁니다' : '') +
      (frames.skippedVector ? ` · 맞출 수 없는 모양 ${frames.skippedVector}개는 그대로` : '') + '. 이름·순서는 그대로이고 되돌리기(Ctrl+Z)로 돌아옵니다.'));
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
          (result.keptLayers ? ` · 레이어 원본을 읽지 못한 모양 ${result.keptLayers}개는 그대로` : '') +
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
  // ---- 모양 이름 한꺼번에 바꾸기 ----
  // 엔트리 이름 칸(nameViewBlur)이 하는 일을 여러 모양에 한다: 모양 이름과 편집 중인 파일 이름을 바꾸고, 모양 목록을
  // 다시 그린 뒤 pictureNameChanged를 알린다. 엔트리 이름 칸과 달리 되돌리기 기록에 한 단계로 넣는다
  // (addPicturesBatch와 같은 방식, 되돌리면 이전 이름으로 같은 일을 하며 다시 하기 단계를 남김). names: [id, 새 이름].
  function renamePictures(objectId, names) {
    const E = window.Entry, object = E.container.getObject(objectId);
    if (!object) return passOf(null);
    const before = [];
    for (const [id, name] of names) {
      const picture = object.pictures.find(item => item.id === id);
      if (!picture || picture.name === name) continue;
      before.push([id, picture.name]);
      picture.name = name;
      const painter = E.playground.painter;
      if (painter?.file?.id === id) painter.file.name = name;
      // 모양 목록 칸은 처음 만들 때 이름을 넣고 다시 만들지 않는다(injectPicture는 칸이 없을 때만 만듦).
      const input = picture.view?.querySelector?.('.entryPlaygroundPictureName');
      if (input) input.value = name;
    }
    E.playground.reloadPlayground?.(); // 엔트리 이름 칸과 같이: 블록 안 모양 이름 표시를 다시 그림
    for (const [id] of before) E.dispatchEvent('pictureNameChanged', object.pictures.find(item => item.id === id));
    // 바꾼 것이 없어도 기록은 남긴다: 엔트리 되돌리기는 되돌린 함수가 다시 하기 칸에 기록을 남겼다고 보고 그 칸을 읽어
    // (stateManager.undo → getLastRedoCommand().isPass), 비어 있으면 오류로 되돌리기가 잠긴다.
    return passOf(E.stateManager?.addCommand('evr rename pictures', null, renamePictures, objectId, before));
  }
  // 이름 칸 처음 값: 고른 첫 모양 이름에서 끝의 번호(_3, 3)를 뗀 것, 없으면 오브젝트 이름.
  const baseName = (name, fallback) => String(name || '').replace(/[_\s-]*\d+$/, '').trim() || fallback;
  let renameDialog = null;
  // 모양 목록에서 고른 것을 위에서부터 "이름_번호"로. 줄 누르기 = 고르기·풀기, Shift+누르기 = 마지막 누른 줄부터 범위.
  // 적용해도 창은 열려 있고 고른 것만 풀려, 종류별(걷기_1…, 뛰기_1…)로 이어서 붙일 수 있다.
  function openRenameDialog(c) {
    if (renameDialog) return renameDialog;
    const E = window.Entry, object = c.object, painter = c.p;
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    const chosen = new Set(object.pictures.map(picture => picture.id));
    let last = -1;
    const backdrop = node('div', 'evr-slicer-backdrop'), dialog = node('section', 'evr-slicer evr-rename');
    dialog.setAttribute('aria-label', '모양 이름 붙이기');
    const header = node('header', 'evr-slicer-head'), closeButton = node('button', 'evr-slicer-x', '×');
    closeButton.type = 'button'; closeButton.title = '닫기';
    header.append(node('h2', '', `모양 이름 붙이기 · ${object.name}`), closeButton);
    const list = node('div', 'evr-rename-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    const stage = node('div', 'evr-slicer-stage');
    stage.append(list, node('p', 'evr-slicer-hint', '줄을 눌러 고르거나 풀고, Shift를 누른 채 누르면 범위를 한 번에 고릅니다.'));
    const side = node('div', 'evr-slicer-side');
    const section = title => { const box = node('div', 'evr-slicer-section'); box.append(node('h3', '', title)); side.append(box); return box; };
    const field = (label, input) => { const row = node('label', 'evr-slicer-field'); row.append(node('span', '', label), input); return row; };
    const nameInput = node('input'); nameInput.type = 'text'; nameInput.maxLength = 60;
    nameInput.value = baseName(object.pictures[0]?.name, object.name);
    const startInput = node('input'); Object.assign(startInput, { type: 'number', min: '0', step: '1', value: '1' });
    section('새 이름').append(field('이름', nameInput), field('시작 번호', startInput),
      node('p', 'evr-slicer-note', '고른 모양을 목록 순서대로 "이름_번호"로 바꿉니다. 되돌리기(Ctrl+Z)로 돌아옵니다.'));
    const all = node('button', '', '모두 고르기'), none = node('button', '', '모두 풀기');
    all.type = none.type = 'button';
    const choose = node('div', 'evr-slicer-row'); choose.append(all, none);
    section('고르기').append(choose);
    const footer = node('footer', 'evr-slicer-foot'), status = node('span', 'evr-slicer-status', '');
    const cancel = node('button', 'evr-slicer-cancel', '닫기'); cancel.type = 'button';
    const apply = node('button', 'evr-slicer-create', '적용'); apply.type = 'button';
    footer.append(status, cancel, apply);
    const body = node('div', 'evr-slicer-body'); body.append(stage, side);
    dialog.append(header, body, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);
    // 고른 모양의 새 이름과, 막아야 할 까닭(빈 이름·고르지 않은 모양과 겹침)
    function plan() {
      const pictures = object.pictures, name = nameInput.value.trim();
      const start = Math.max(0, Math.floor(Number(startInput.value) || 0));
      const names = new Map();
      let n = start;
      for (const picture of pictures) if (chosen.has(picture.id)) names.set(picture.id, `${name}_${n++}`);
      const others = new Set(pictures.filter(picture => !chosen.has(picture.id)).map(picture => picture.name));
      const clash = [...names.values()].filter(value => others.has(value));
      const problem = !names.size ? '이름을 바꿀 모양을 고르세요.' : !name ? '이름을 넣으세요.' :
        clash.length ? `고르지 않은 모양과 이름이 겹칩니다: ${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ' 등' : ''}` : '';
      return { names, problem };
    }
    function render(message) {
      const { names, problem } = plan();
      list.replaceChildren(...object.pictures.map((picture, i) => {
        const row = node('div', 'evr-rename-row');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(chosen.has(picture.id)));
        row.dataset.index = String(i);
        const thumb = node('img', 'evr-rename-thumb');
        thumb.alt = ''; thumb.draggable = false;
        try { thumb.src = new URL(painter.getImageSrc(picture), location.href).href; } catch (error) { /* 그림 주소 없음 */ }
        const next = names.get(picture.id);
        row.append(node('span', 'evr-rename-index', String(i + 1)), thumb, node('span', 'evr-rename-old', picture.name),
          node('span', 'evr-rename-new', next && next !== picture.name ? `→ ${next}` : ''));
        return row;
      }));
      apply.disabled = !!problem;
      status.textContent = message || problem || `고른 모양 ${names.size}개`;
    }
    list.addEventListener('click', event => {
      const row = event.target.closest?.('.evr-rename-row');
      if (!row) return;
      const i = Number(row.dataset.index), pictures = object.pictures;
      if (event.shiftKey && last >= 0) {
        const [a, b] = i < last ? [i, last] : [last, i];
        for (let k = a; k <= b; k++) chosen.add(pictures[k].id);
      } else if (chosen.has(pictures[i].id)) chosen.delete(pictures[i].id);
      else chosen.add(pictures[i].id);
      last = i;
      render();
    });
    // Shift+누르기가 글자를 고르지 않게
    list.addEventListener('mousedown', event => { if (event.shiftKey) event.preventDefault(); });
    all.addEventListener('click', () => { object.pictures.forEach(picture => chosen.add(picture.id)); render(); });
    none.addEventListener('click', () => { chosen.clear(); last = -1; render(); });
    nameInput.addEventListener('input', () => render());
    startInput.addEventListener('input', () => render());
    function run() {
      const { names, problem } = plan();
      if (problem) { render(); return; }
      renamePictures(object.id, [...names]);
      const count = names.size;
      chosen.clear(); last = -1;
      render(`모양 ${count}개 이름을 바꿨습니다 · 되돌리기(Ctrl+Z) 가능 · 다음 묶음을 고르세요`);
    }
    apply.addEventListener('click', run);
    // 키는 창에서 먼저 받아 뒤의 엔트리 편집기로 가지 않게 한다(중심 맞추기 창과 같음).
    function onKey(event) {
      if (!(event.target instanceof Node) || (!dialog.contains(event.target) && event.target !== document.body)) return;
      if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.type === 'keydown' && event.key === 'Enter' && (event.target === nameInput || event.target === startInput)) {
        event.preventDefault(); run();
      }
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    function close() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      backdrop.remove();
      renameDialog = null;
    }
    closeButton.addEventListener('click', close);
    cancel.addEventListener('click', close);
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); });
    renameDialog = { close };
    render();
    nameInput.focus({ preventScroll: true });
    nameInput.select();
    return renameDialog;
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
      // 벡터 모양은 엔트리가 함께 저장한 실행 화면 PNG(없으면 SVG)를 시트로 쓴다 — 나눈 조각은 비트맵 모양이 된다
      if (picture.imageType === 'svg' && !pixelOf(picture)) {
        useSheet(await pixelArtOf(picture), picture.name, `모양 "${picture.name}"(벡터 → 그림)`);
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
          (result.keptLayers ? ` · 레이어 원본을 읽지 못한 모양 ${result.keptLayers}개는 그대로` : '') +
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
    // 비트맵 탭: 그림(Raster) 한 장이 레이어 하나(open에서 그림 칸만큼 넓혀 둠)
    // 벡터 탭: 경로가 든 맨 위 항목과 그림(Raster) 항목이 레이어 — 비트맵에서 바꿔 온 그림 레이어도 비트맵 뼈대 방식으로 휜다(사용자 요구,
    // 예전엔 경로만 골라 "벡터 도형이 없습니다"). 그림은 돌리거나 늘리지 않은(1화소 = 그림 1) 칠해진 것만.
    // 엔트리 [그룹화]로 묶은 그림도 레이어 하나(groupParts — 예전엔 그림만 든 묶음은 빠져 "벡터 도형이나 그림이 없습니다", 사용자 제보)
    const layers = bitmapMode(c) ? c.layer.children.filter(isRasterLayer).slice(0, 1) :
      c.layer.children.filter(item => item.data?.entryVectorCanvasBox !== '1' && !isLayerHelper(item) &&
        (isRasterLayer(item) ? plainRaster(item) && !!rasterInk(item) : pathItems(item).length > 0 || groupParts(item).length > 0));
    const s = { ...c, art, layers, opener,
      rigs: new Map(), base: new Map(), current: null, selectedJoint: -1, hover: null,
      stage: 'setup', ik: false, previews: new Map(), restBounds: new Map(),
      dragging: null, ui: null, overlay: null, history: [], historyIndex: 0, cache: new Map() };
    if (!bitmapMode(c)) migrateOldSkin(s);
    for (const item of s.layers) {
      let rig = null;
      try { rig = JSON.parse(item.data?.[BONES] || 'null'); } catch { /* 깨진 데이터는 쓰지 않는다 */ }
      if (isRasterLayer(item)) {
        // 휘기 전 그림: 휜 채 남긴 그림 데이터(open이 읽어 둠), 아니면 지금 그림
        const hadRest = !!restCanvasOf(item);
        if (!hadRest) restCanvases.set(item, restHere(item));
        if (!validRig(rig) || !rig.bitmap) {
          // 모양 정보에 남긴 관절은 비트맵 탭 그림 한 장 것이다(벡터 탭 그림 레이어마다 붙이면 모두 같은 관절이 된다)
          const joints = bitmapMode(s) ? savedBitmapJoints(s) : null;
          rig = joints ? bitmapRigBase(s, item, joints) : null;
          if (rig) rig.sig = rasterSig(item);
          // 파일에서 읽은 레이어 관절은 이제 그림 data 뼈대가 이어 간다(남겨 두면 관절을 다 지워도 다음에 열 때 되살아난다)
          const meta = rig && layerMeta(s.ep), kept = meta && layerBonesOf(activeLayer(meta));
          if (kept && !kept.bones) delete activeLayer(meta).bonesRef;
        }
        if (!validRig(rig)) {
          // 뼈대가 없는 그림은 지금 그림이 휘기 전 그림이다 — 묶음에서 풀었거나 관절을 모두 지운 뒤 남은 옛 휘기 전 그림(같은 탭 기억·그림 데이터)을
          // 쓰면 뼈를 넣는 순간 옛 모양·옛 자리로 돌아갔다(검토 L). 비트맵 탭은 모양 정보 관절(위)을 쓰므로 그대로.
          if (!bitmapMode(s)) { restCanvases.set(item, restHere(item)); delete item.data[BITMAP_REST]; }
          continue;
        }
        rig.pose = Object.fromEntries(Object.entries(rig.pose).map(([id, angle]) => [id, Number(angle)]));
        rig = reconcileBitmapRig(s, rig, item, hadRest);
        s.rigs.set(item, rig);
        persist(s, item, true);
        touch(s, item);
        continue;
      }
      const parts = groupParts(item);
      if (parts.length) {
        // 묶음 안 그림: 휘기 전 그림을 모두 들고 있었는지(휜 채 남긴 것은 open이 읽어 둠) 본 뒤, 없는 것은 지금 그림으로
        const hadRest = parts.every(raster => !!restCanvasOf(raster));
        if (!validRig(rig)) {
          parts.forEach(raster => { restCanvases.set(raster, partRestHere(raster)); delete raster.data[BITMAP_REST]; }); // 위 그림 레이어와 같은 까닭
          continue;
        }
        parts.forEach(raster => { if (!restCanvasOf(raster)) restCanvases.set(raster, partRestHere(raster)); });
        rig.pose = Object.fromEntries(Object.entries(rig.pose).map(([id, angle]) => [id, Number(angle)]));
        rig = reconcileGroupRig(s, rig, item, parts, hadRest);
        (rig.parts || []).forEach((part, i) => { const rest = restCanvases.get(parts[i]); if (rest) rest.at = { x: part.bitmap.x, y: part.bitmap.y }; });
        s.rigs.set(item, rig);
        persist(s, item, true);
        touch(s, item);
        continue;
      }
      if (rig?.parts) {
        // 묶음 안 그림을 하나도 못 쓰게 됐으면(엔트리로 묶음을 돌리거나 늘림 등) 그림 기준을 버린다 — 남으면 휘기가 매번 멈췄다(검토 L)
        delete rig.parts;
        for (const raster of item.getItems({ match: node => isRasterLayer(node) })) delete raster.data[BITMAP_REST];
      }
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
  function persist(s, item, quiet) {
    const rig = s.rigs.get(item);
    if (rig && isRasterLayer(item)) rig.sig = rasterSig(item);
    if (rig?.parts && !isRasterLayer(item)) {
      const parts = groupParts(item);
      if (parts.length === rig.parts.length) parts.forEach((raster, i) => { rig.parts[i].sig = partSig(raster); });
    }
    if (rig) item.data[BONES] = JSON.stringify(rig);
    else delete item.data[BONES];
    // 비트맵: 휘어 있는 동안만 휘기 전 그림을 같이 둔다(엔트리 되돌리기 기록에도 그림 데이터째 남는다). 묶음 안 그림은 그림마다.
    for (const raster of isRasterLayer(item) ? [item] : !rig || rig.parts ? groupParts(item) : []) {
      if (rig && posed(rig)) raster.data[BITMAP_REST] = restUrlOf(raster);
      else delete raster.data[BITMAP_REST];
    }
    if (!quiet) s.p.file.modified = true;
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
      if (isRasterLayer(item)) deformLayer(s, item); // 비트맵은 기록에 그림 대신 자세만 두고 다시 그린다
      else if (groupParts(item).length) renderParts(s, item, s.rigs.get(item) || null); // 묶음 안 그림도(경로는 위에서 되돌림)
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
  // 섞기는 벡터(경로 앵커·손잡이)와 비트맵(삼각망 꼭짓점)이 같이 쓴다.
  function dqsBlend(paper, skin, rig) {
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
    return { mix, anchorTransform, place };
  }
  function skinPathData(paper, skin, rig) {
    const { mix, anchorTransform, place } = dqsBlend(paper, skin, rig);
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
    if (isRasterLayer(item)) {
      renderBitmapPose(s, item, rig || null); // 요약(rig.sig)은 기록할 때(persist) 잰다
      s.ep.paper.view.update();
      return;
    }
    if (!rig) return;
    if (leaves.length !== rig.source.length)
      throw Error('레이어의 경로 구조가 달라져 휘기를 멈췄습니다.');
    if (leaves.length) {
      const data = madePaths(s, item, rig, leaves);
      leaves.forEach((leaf, i) => setWorldPathData(s.ep.paper, leaf, data[i]));
      rig.sig = shapeSig(item);
    }
    if (rig.parts) renderParts(s, item, rig); // 묶음 안 그림도 같은 뼈로
    s.ep.paper.view.update();
  }

  // ---- 비트맵 뼈대 ----
  // 엔트리 비트맵 탭의 그림은 Raster 한 장이다. 그 한 장을 레이어 하나로 보고 벡터와 같은 표준 스키닝을 쓴다:
  //  1) 칠해진 곳(알파 > 0, 가장자리 반투명까지 덮게 2px 넓힘)의 윤곽선을 d3-contour(마칭 스퀘어)로 따서 기준 모양
  //     경로(rig.source)로 삼는다 — Spine 메시 "Trace"처럼 그림 윤곽으로 메시 테두리를 만든다. 삼각망·bone heat 가중치는
  //     벡터와 같은 함수(skinMesh·heatWeights)가 이 윤곽선으로 만든다.
  //  2) 삼각망 꼭짓점을 DQS로 옮기고(dqsBlend), 휘기 전 그림을 삼각형마다 옮겨 그린다(텍스처 메시 — Spine·DragonBones 런타임이
  //     메시를 그리는 방식). WebGL로 그리고, 없으면 캔버스 2D 삼각형 아핀 그리기로 대신한다.
  // 휘기 전 그림은 휘어 있는 동안만 그림 데이터에 둔다(BITMAP_REST, data URL). 자세가 0이면 지금 그림이 곧 기준이다.
  // 엔트리는 비트맵을 PNG로만 저장해 그림 데이터가 남지 않으므로, 저장할 때 관절을 모양 정보(dimension.entryVectorBitmapRig,
  // 십자 기준 좌표)에 남기고 다음에 열 때 쓴다. 휜 채로 저장하면 그 자세를 새 기준으로 삼는다(벡터 bakeRig와 같은 뜻).
  const BITMAP_REST = 'entryVectorBitmapRest';
  const BITMAP_RIG = 'entryVectorBitmapRig';
  const isRasterLayer = item => item?.className === 'Raster';
  // 화면에 그려진 그대로의 비트맵 사본(캔버스)
  function rasterCopy(raster) {
    const canvas = canvasOfSize(raster.width, raster.height);
    const source = raster.canvas || raster.image;
    if (source) canvas.getContext('2d').drawImage(source, 0, 0);
    return canvas;
  }
  // 비트맵 요약(화소 해시 + 자리). 뼈대 모드 밖에서 그림을 고쳤는지 알아보는 데 쓴다. 줄여 그린 뒤 재면 크롬이 줄이는 방식
  // (GPU·CPU)에 따라 같은 그림도 값이 달라져(실제 엔트리: 그대로인 그림이 두 값 사이를 오감) 화소를 그대로 읽는다.
  // 무거우므로 끄는 동안에는 재지 않고 기록할 때(persist)만 잰다. 화소는 하나도 건너뛰지 않는다(건너뛰면 1px 획을 못 알아봐
  // 휜 그림을 휘기 전 그림으로 잘못 잡을 수 있었다 — 검토로 찾음). 자리(x, y)는 따로 둬 옮기기만 한 것을 알아본다.
  function rasterSig(raster) {
    let data = null;
    try { data = raster.getImageData({ x: 0, y: 0, width: raster.width, height: raster.height }).data; } catch { data = null; }
    const b = raster.bounds;
    return { abs: `${pixelHash(data)}:${raster.width}x${raster.height}`, x: clean(b.x), y: clean(b.y) };
  }
  // 레이어 사본({ canvas, x, y })의 같은 요약
  function contentSig(content) {
    const { canvas } = content;
    let data = null;
    try { data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; } catch { data = null; }
    return { abs: `${pixelHash(data)}:${canvas.width}x${canvas.height}`, x: clean(content.x), y: clean(content.y) };
  }
  function pixelHash(data) {
    let h = 2166136261;
    if (data) for (let i = 0; i < data.length; i += 4) h = Math.imul(h ^ (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24), 16777619);
    else h = 0;
    return (h >>> 0).toString(36);
  }
  // 뼈대를 기록한 뒤 그림만 옮겼으면(그림 전체 이동 — 화소 같고 자리만 다름) 관절도 그만큼. 다시 열 때 reconcileBitmapRig가 하는 판단과 같다 —
  // 저장은 다시 열기 전에도 하므로 기록할 때 맞춘다.
  function rigMovedTo(rig, sig) {
    if (!rig?.sig || !sig || rig.sig.abs !== sig.abs || !Number.isFinite(rig.sig.x) || !Number.isFinite(rig.sig.y)) return rig;
    const dx = sig.x - rig.sig.x, dy = sig.y - rig.sig.y;
    if (Math.abs(dx) <= .01 && Math.abs(dy) <= .01) return rig;
    return { ...rig, joints: rig.joints.map(j => ({ ...j, x: clean(j.x + dx), y: clean(j.y + dy) })) };
  }
  // 칠해진 곳 윤곽선(그림 좌표 경로 글 목록). 큰 그림은 줄여서 딴다(화소 60만 개 안).
  function rasterOutline(paper, canvas, x, y) {
    const k = Math.min(1, Math.sqrt(600000 / (canvas.width * canvas.height)));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    const small = canvasOfSize(w, h), ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const alpha = ctx.getImageData(0, 0, w, h).data, mask = new Float64Array(w * h);
    const reach = Math.max(1, Math.round(2 * k)); // 반투명 가장자리까지 덮게 넓힘
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!alpha[(j * w + i) * 4 + 3]) continue;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const u = i + dx, v = j + dy;
        if (u >= 0 && v >= 0 && u < w && v < h) mask[v * w + u] = 1;
      }
    }
    const shape = window.__evrD3Contour?.contours().size([w, h]).thresholds([.5])(mask)[0];
    const out = [];
    for (const polygon of shape?.coordinates || []) {
      const compound = new paper.CompoundPath({ insert: false });
      for (const ring of polygon) {
        if (ring.length < 4) continue;
        const raw = new paper.Path({ segments: ring.map(([px, py]) => [x + px / k, y + py / k]), closed: true, insert: false });
        const fit = raw.clone({ insert: false });
        if (raw.segments.length > 8) fit.simplify(1); // 계단만 펴는 정도
        compound.addChild(raw.segments.length > 8 && !fit.getIntersections().length ? fit : raw);
      }
      if (compound.children.length && Math.abs(compound.area) > 4) out.push(compound.pathData);
    }
    return out;
  }
  // 휘기 전 그림. 세션 동안 캔버스로 들고, 휜 상태를 저장할 때만 data URL로 바꾼다.
  // at: 휘기 전 그림의 왼쪽 위(그림 좌표). 벡터 탭 그림 레이어는 휠 때 그림 크기·자리가 바뀌어(fitRasterTo), 뼈대가 없어질 때(관절 모두
  // 지우기 등) 지금 자리에 그리면 휜 만큼 밀렸다(검토로 찾음, 실제 엔트리 재현: 400×60 막대가 위로 173px 밀림).
  const restCanvases = new WeakMap(); // 그림(Raster) → { canvas, url, at? }
  function restCanvasOf(item) { return restCanvases.get(item)?.canvas || null; }
  const restHere = item => ({ canvas: rasterCopy(item), url: null, at: { x: Math.round(item.bounds.left), y: Math.round(item.bounds.top) } });
  // 남긴 뼈대(그림 데이터)의 휘기 전 그림 자리
  function savedRestAt(item) {
    try { const at = JSON.parse(item.data?.[BONES] || 'null')?.bitmap; return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null; } catch { return null; }
  }
  function restUrlOf(item) {
    const rest = restCanvases.get(item);
    if (!rest) return null;
    rest.url ||= rest.canvas.toDataURL('image/png');
    return rest.url;
  }
  // 그림 칸(작업 영역)만큼 비트맵을 넓혀 둔다. 엔트리가 불러온 그림은 그림 크기 Raster라, 휜 팔이 그 밖으로 나가면 잘린다.
  function fillRasterToStage(c) {
    const raster = c.layer.children.find(isRasterLayer), stage = c.stage;
    if (!raster || !stage) return raster || null;
    const b = raster.bounds;
    if (b.left <= stage.left + .5 && b.top <= stage.top + .5 && b.right >= stage.right - .5 && b.bottom >= stage.bottom - .5)
      return raster;
    const left = Math.min(b.left, stage.left), top = Math.min(b.top, stage.top);
    const width = Math.round(Math.max(b.right, stage.right) - left), height = Math.round(Math.max(b.bottom, stage.bottom) - top);
    const canvas = canvasOfSize(width, height), source = raster.canvas || raster.image;
    if (source) canvas.getContext('2d').drawImage(source, Math.round(b.left - left), Math.round(b.top - top));
    const wide = new c.ep.paper.Raster({ insert: false });
    wide.setImage(canvas);
    wide.position = new c.ep.paper.Point(left + width / 2, top + height / 2);
    Object.assign(wide.data, raster.data);
    // 뼈대 맞추기는 넓히기 전 그림으로 판단한다(옮기기만 한 그림을 넓히면 크기가 달라져 "고친 그림"으로 보였다). 휘기 전 그림도 넘긴다.
    if (raster.data?.[BONES]) wide.__evrSigBefore = rasterSig(raster);
    const rest = restCanvases.get(raster);
    if (rest) restCanvases.set(wide, rest);
    raster.replaceWith(wide);
    return wide;
  }
  // 엔트리 비트맵 그림은 1화소 = 그림 1(돌리거나 늘리지 않음)이라야 이 방식으로 다룬다.
  // 뒤집거나 돌린 그림도 뺀다(크기만 보면 좌우로 뒤집거나 180° 돌린 그림·90° 돌린 정사각 그림이 통과해 뼈대가 뒤집기 전 그림으로 휘었음 — 검토 L)
  const plainRaster = raster => {
    const m = raster.matrix;
    return m.a > 0 && m.d > 0 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 &&
      Math.abs(raster.bounds.width - raster.width) < .5 && Math.abs(raster.bounds.height - raster.height) < .5;
  };
  // ---- 묶음 레이어 안의 그림 ----
  // 사용자 결정(10-18, 제보 "비트맵 레이어를 그룹화 하면 뼈대에서 레이어 인식이 안돼"): 엔트리 [그룹화]로 묶은 묶음은 벡터 레이어처럼
  // 레이어 하나이고, 뼈대 하나로 안의 그림(Raster)이 모두 같이 휜다(합치지 않음). 그림마다 자기 윤곽선 삼각망·가중치로 같은 뼈를 따른다
  // (Spine의 뼈대 하나·그림 조각 여럿과 같음). 묶음 안 경로는 지금처럼 묶음 전체가 한 삼각망. 그림마다의 기준(윤곽선·휘기 전 자리·요약)은
  // 묶음 뼈대의 parts에 그림 차례대로 두고, 휘기 전 그림 데이터(BITMAP_REST)는 그림마다 둔다. 돌리거나 늘린 그림·묶음은 빼고, 빈 그림도 뺀다.
  function groupParts(item) {
    if (!item?.children || isRasterLayer(item)) return [];
    return item.getItems({ match: node => isRasterLayer(node) }).filter(raster => {
      for (let node = raster.parent; node && node.className !== 'Layer'; node = node.parent) {
        const m = node.matrix;
        if (Math.abs(m.a - 1) > 1e-9 || Math.abs(m.d - 1) > 1e-9 || Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9) return false;
      }
      return plainRaster(raster) && !!rasterInk(raster);
    });
  }
  // 묶음 안 그림의 자리는 그림 좌표로 다룬다: 엔트리 묶음은 applyMatrix=false라 묶음을 옮기면 안의 그림이 아니라 묶음 행렬에 남는다
  // (실제 엔트리로 확인 — 옮긴 뒤 예전엔 뼈대 목록에서 다시 빠졌음). 옮기기만 한 묶음 안이면 그 이동을 더한다.
  function partShift(raster) {
    let x = 0, y = 0;
    for (let node = raster.parent; node && node.className !== 'Layer'; node = node.parent) { x += node.matrix.tx; y += node.matrix.ty; }
    return { x, y };
  }
  function partRestHere(raster) {
    const shift = partShift(raster);
    return { canvas: rasterCopy(raster), url: null, at: { x: Math.round(raster.bounds.left + shift.x), y: Math.round(raster.bounds.top + shift.y) } };
  }
  function partSig(raster) {
    const sig = rasterSig(raster), shift = partShift(raster);
    return { ...sig, x: clean(sig.x + shift.x), y: clean(sig.y + shift.y) };
  }
  const partRig = (rig, part) => ({ joints: rig.joints, pose: rig.pose, radius: rig.radius, source: part.source, bitmap: part.bitmap });
  // 그림 하나의 기준: 휘기 전 그림(세션이 들고 있는 것)과 그 자리로 윤곽선·자리·요약
  function partBase(s, raster) {
    if (!restCanvasOf(raster)) restCanvases.set(raster, partRestHere(raster));
    const rest = restCanvasOf(raster), b = restCanvases.get(raster).at || partRestHere(raster).at;
    return { source: rasterOutline(s.ep.paper, rest, b.x, b.y), bitmap: { x: clean(b.x), y: clean(b.y), w: rest.width, h: rest.height }, sig: partSig(raster) };
  }
  function renderParts(s, item, rig) {
    if (rig && !rig.parts) return; // 예전 뼈대(경로만, reconcileGroupRig)
    const parts = groupParts(item);
    if (rig && (rig.parts || []).length !== parts.length) throw Error('묶음 안 그림이 달라져 휘기를 멈췄습니다.');
    parts.forEach((raster, i) => renderBitmapPose(s, raster, rig ? partRig(rig, rig.parts[i]) : null, partShift(raster)));
  }
  // 뼈대 모드 밖에서 묶음이 바뀌었으면 맞춘다. 통째로 옮기기만 했으면(경로 모양·그림 화소 그대로, 모두 같은 거리) 뼈대와 기준을 같이
  // 옮긴다. 그 밖(그림을 더하거나 빼거나 고침, 경로를 고침, 휜 상태인데 휘기 전 그림을 모름, 예전 뼈대라 그림 기준이 없음)이면 지금 보이는
  // 모양을 새 기준으로(관절은 지금 자세 자리, 각도 0) — 비트맵 레이어(reconcileBitmapRig)와 같은 뜻.
  function reconcileGroupRig(s, rig, item, parts, hadRest) {
    // 그림 기준이 없는 예전 뼈대(1.3 전 도형+그림 묶음)가 휘어 있으면 지금처럼 경로만 휘는 뼈대로 둔다 — 새 기준으로 바꾸면 곧게 펴기로 원래
    // 모양에 못 돌아간다(검토 L). 자세가 0이 되어 다시 열면 그때 그림 기준을 붙인다.
    if (!rig.parts && posed(rig)) { reconcileRig(s, rig, item); return rig; }
    const sigs = parts.map(raster => partSig(raster)), shape = shapeSig(item), old = rig.parts || [];
    const sameParts = old.length === parts.length && old.every((part, i) => part.sig?.abs === sigs[i].abs && part.bitmap && part.source);
    const samePaths = shape ? !!rig.sig && shape.rel === rig.sig.rel && rig.source.length === pathItems(item).length : !rig.source.length;
    if (sameParts && samePaths) {
      const moves = sigs.map((sig, i) => [sig.x - old[i].sig.x, sig.y - old[i].sig.y]);
      if (shape) moves.push([shape.x0 - rig.sig.x0, shape.y0 - rig.sig.y0]);
      const [dx, dy] = moves[0];
      if (moves.every(([x, y]) => Math.abs(x - dx) < .01 && Math.abs(y - dy) < .01)) {
        if (Math.abs(dx) > .01 || Math.abs(dy) > .01) {
          rig.joints = rig.joints.map(j => ({ ...j, x: clean(j.x + dx), y: clean(j.y + dy) }));
          if (rig.source.length) rig.source = shiftPaths(rig.source, dx, dy);
          rig.parts = old.map((part, i) => ({ source: part.source.length ? shiftPaths(part.source, dx, dy) : part.source,
            bitmap: { ...part.bitmap, x: clean(part.bitmap.x + dx), y: clean(part.bitmap.y + dy) }, sig: sigs[i] }));
          if (shape) rig.sig = shape;
        }
        if (hadRest || !posed(rig)) return rig;
      }
    }
    const points = jointPoints(rig);
    parts.forEach(raster => restCanvases.set(raster, partRestHere(raster)));
    return { joints: rig.joints.map(j => ({ ...j, x: clean(points[j.id].x), y: clean(points[j.id].y) })), pose: {},
      source: pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf)), radius: rig.radius, sig: shape,
      parts: parts.map(raster => partBase(s, raster)) };
  }
  // 묶음 안 그림의 휘기 전 자리(남긴 묶음 뼈대에서) — 휜 채 남긴 그림을 열 때 쓴다
  function partRestAt(c, raster) {
    let top = raster;
    while (top.parent && top.parent !== c.layer) top = top.parent;
    try {
      const rig = JSON.parse(top.data?.[BONES] || 'null'), at = rig?.parts?.[groupParts(top).indexOf(raster)]?.bitmap;
      return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null;
    } catch { return null; }
  }
  // 꼭짓점마다 DQS로 옮긴 자리(그림 좌표)
  function skinVertices(paper, skin, rig) {
    const { anchorTransform, place } = dqsBlend(paper, skin, rig), { pts, n } = skin.mesh, out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = place(anchorTransform(i), pts[2 * i], pts[2 * i + 1]);
      out[2 * i] = p.x; out[2 * i + 1] = p.y;
    }
    return out;
  }
  let meshGL;
  function meshRenderer() {
    if (meshGL !== undefined) return meshGL;
    meshGL = null;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true });
      if (!gl) return null;
      const shader = (type, source) => {
        const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER,
        'attribute vec2 aPos;attribute vec2 aUV;uniform vec2 uSize;varying vec2 vUV;' +
        'void main(){vec2 p=aPos/uSize*2.0-1.0;gl_Position=vec4(p.x,-p.y,0.0,1.0);vUV=aUV;}'));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER,
        'precision mediump float;varying vec2 vUV;uniform sampler2D uTex;void main(){gl_FragColor=texture2D(uTex,vUV);}'));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
      meshGL = { canvas, gl, program, pos: gl.createBuffer(), uv: gl.createBuffer(), index: gl.createBuffer(),
        texture: gl.createTexture(), max: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        aPos: gl.getAttribLocation(program, 'aPos'), aUV: gl.getAttribLocation(program, 'aUV'),
        uSize: gl.getUniformLocation(program, 'uSize'), uTex: gl.getUniformLocation(program, 'uTex') };
    } catch (error) { console.warn('[entry-vector-rig] WebGL 메시 그리기를 못 써 캔버스로 그립니다', error); meshGL = null; }
    return meshGL;
  }
  // 휘기 전 그림(source, 그림 좌표 sx·sy에 놓인)을 삼각형마다 옮겨 out(그림 좌표 ox·oy부터) 캔버스에 그린다.
  function drawMesh(out, ox, oy, source, sx, sy, mesh, moved, nearest) {
    const ctx = out.getContext('2d');
    ctx.clearRect(0, 0, out.width, out.height);
    const { pts, tris } = mesh;
    // WebGL 문맥을 잃으면(GPU 재시작 등) 아무것도 안 그려져 휜 그림이 투명해진다 — 새로 만들고, 못 만들면 캔버스 2D로
    if (meshGL?.gl?.isContextLost()) meshGL = undefined;
    const r = meshRenderer();
    if (r && out.width <= r.max && out.height <= r.max && source.width <= r.max && source.height <= r.max && mesh.n < 65536) {
      const { gl } = r;
      r.canvas.width = out.width; r.canvas.height = out.height;
      gl.viewport(0, 0, out.width, out.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(r.program);
      const pos = new Float32Array(mesh.n * 2), uv = new Float32Array(mesh.n * 2);
      for (let i = 0; i < mesh.n; i++) {
        pos[2 * i] = moved[2 * i] - ox; pos[2 * i + 1] = moved[2 * i + 1] - oy;
        uv[2 * i] = (pts[2 * i] - sx) / source.width; uv[2 * i + 1] = (pts[2 * i + 1] - sy) / source.height;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, r.pos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(r.aPos); gl.vertexAttribPointer(r.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.uv); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(r.aUV); gl.vertexAttribPointer(r.aUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(tris), gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      const filter = nearest ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(r.uTex, 0); gl.uniform2f(r.uSize, out.width, out.height);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 겹쳐 접힌 곳은 위 삼각형이 덮는다
      gl.drawElements(gl.TRIANGLES, tris.length, gl.UNSIGNED_SHORT, 0);
      ctx.drawImage(r.canvas, 0, 0);
      return;
    }
    // 캔버스 2D: 삼각형마다 휘기 전 → 휜 자리 아핀 변환으로 잘라 그린다. 자르기 가장자리가 부드럽게 처리돼 이웃 삼각형 사이에
    // 옅은 실금이 보여(WebGL 없이 시험: 0.5px 넓힘으로도 보임) 1px 넓혀 겹치게 자른다.
    ctx.imageSmoothingEnabled = !nearest;
    for (let k = 0; k < tris.length; k += 3) {
      const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]];
      const u0 = pts[2 * a] - sx, v0 = pts[2 * a + 1] - sy, u1 = pts[2 * b] - sx, v1 = pts[2 * b + 1] - sy, u2 = pts[2 * c] - sx, v2 = pts[2 * c + 1] - sy;
      const x0 = moved[2 * a] - ox, y0 = moved[2 * a + 1] - oy, x1 = moved[2 * b] - ox, y1 = moved[2 * b + 1] - oy, x2 = moved[2 * c] - ox, y2 = moved[2 * c + 1] - oy;
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(det) < 1e-9) continue;
      const ia = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det, ic = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
      const ib = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det, id = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
      const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, grow = (x, y) => {
        const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + dx / l, y + dy / l];
      };
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(...grow(x0, y0)); ctx.lineTo(...grow(x1, y1)); ctx.lineTo(...grow(x2, y2)); ctx.closePath();
      ctx.clip();
      ctx.setTransform(ia, ib, ic, id, x0 - ia * u0 - ic * v0, y0 - ib * u0 - id * v0);
      ctx.drawImage(source, 0, 0);
      ctx.restore();
    }
  }
  // 비트맵 레이어를 지금 자세로 다시 그린다(자세가 0이면 휘기 전 그림 그대로).
  // 벡터 탭 그림 레이어는 칸 크기 그림이 아니라 칠해진 곳 크기라, 그림 크기를 휜 결과(휘기 전이면 휘기 전 그림)에 맞춰 바꾼다.
  // 칸만큼 미리 넓혀 두면 엔트리 선택 상자·저장 SVG 그림이 커져 다른 기능까지 칸 크기로 본다.
  function fitRasterTo(P, item, canvas, left, top) {
    replaceRasterImage(item, canvas);
    item.position = new P.Point(left + canvas.width / 2, top + canvas.height / 2);
  }
  // paper가 SVG에서 불러온 그림(Raster)은 '다 불러오면 크기·자리 맞추기' 처리(paper 0.12.15 importSVG의 image: on('load', 가운데로 옮김))를
  // 계속 달고 있어, 나중에 setImage를 부르면 paper가 load를 다시 알려 그림이 SVG 좌표만큼 한 번 더 밀렸다(저장했다 다시 연 그림을 뼈대로 휘면
  // 엉뚱한 곳으로 감 — 시험으로 재현). 이미 불러온 그림이면 그 처리를 떼고 바꾼다.
  function replaceRasterImage(raster, canvas) {
    if (raster.loaded && raster.responds('load')) raster.off('load');
    raster.setImage(canvas);
  }
  // shift: 묶음 안 그림이면 묶음들의 옮기기(그림 좌표 = 그림의 부모 좌표 + shift, partShift)
  function renderBitmapPose(s, item, rig, shift = { x: 0, y: 0 }) {
    const rest = restCanvasOf(item);
    if (!rest) throw Error('휘기 전 그림을 찾지 못해 휘기를 멈췄습니다.');
    const fit = !bitmapMode(s);
    const origin = item.bounds.topLeft;
    // 벡터 탭 그림은 휘면 자리가 바뀌므로 뼈대가 없을 때는 휘기 전 그림을 남긴 자리(비트맵 탭은 칸 크기 그림이라 그대로)
    const at0 = rig?.bitmap || (fit && restCanvases.get(item)?.at) || { x: origin.x, y: origin.y };
    if (!rig || !posed(rig) || rig.joints.length < 2) {
      if (fit) { fitRasterTo(s.ep.paper, item, copyCanvas(rest), Math.round(at0.x) - shift.x, Math.round(at0.y) - shift.y); return; }
      const ctx = item.getContext(true);
      ctx.clearRect(0, 0, item.width, item.height);
      ctx.drawImage(rest, Math.round(at0.x - origin.x), Math.round(at0.y - origin.y));
      return;
    }
    const skin = cachedSkin(s, item, rig, null);
    const moved = skinVertices(s.ep.paper, skin, rig);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let i = 0; i < skin.mesh.n; i++) {
      left = Math.min(left, moved[2 * i]); right = Math.max(right, moved[2 * i]);
      top = Math.min(top, moved[2 * i + 1]); bottom = Math.max(bottom, moved[2 * i + 1]);
    }
    s.cache.set(`bounds:${item.id}`, new s.ep.paper.Rectangle(left, top, right - left, bottom - top));
    if (fit) {
      // 화소 칸에 맞춘 휜 범위(가장자리 번짐 1px 여유)
      const x0 = Math.floor(left) - 1, y0 = Math.floor(top) - 1;
      const out = canvasOfSize(Math.max(1, Math.ceil(right) + 1 - x0), Math.max(1, Math.ceil(bottom) + 1 - y0));
      drawMesh(out, x0, y0, rest, at0.x, at0.y, skin.mesh, moved, objectPixel(s.object) > 0);
      fitRasterTo(s.ep.paper, item, out, x0 - shift.x, y0 - shift.y);
      return;
    }
    const ctx = item.getContext(true);
    const out = canvasOfSize(item.width, item.height);
    drawMesh(out, origin.x, origin.y, rest, at0.x, at0.y, skin.mesh, moved, objectPixel(s.object) > 0);
    ctx.clearRect(0, 0, item.width, item.height);
    ctx.drawImage(out, 0, 0);
  }
  // 휘기 전 그림으로 새 뼈대 기준을 만든다(관절은 이미 정한 자리).
  function bitmapRigBase(s, item, joints) {
    // 벡터 탭 그림은 휘기 전 그림을 남긴 자리 기준(휜 그림은 자리가 바뀜), 비트맵 탭은 칸 크기 그림 그대로
    const rest = restCanvasOf(item), b = (!bitmapMode(s) && restCanvases.get(item)?.at) || { x: item.bounds.left, y: item.bounds.top };
    return { joints, pose: {}, source: rasterOutline(s.ep.paper, rest, b.x, b.y),
      bitmap: { x: clean(b.x), y: clean(b.y), w: rest.width, h: rest.height }, radius: radiusOf(item), sig: null };
  }
  // 뼈대 모드 밖에서 그림을 고쳤으면(화소 요약이 마지막으로 그린 것과 다름) 지금 그림을 새 기준으로: 관절은 지금 자세 자리로,
  // 각도 0. 옮기기만 했으면(화소 같고 자리만 다름) 관절·휘기 전 그림 자리·기준 윤곽도 같이 옮긴다. 휜 상태인데 휘기 전 그림을
  // 모르면(hadRest 거짓) 지금 휜 그림을 휘기 전 그림으로 쓰면 두 번 휘므로 새 기준으로 삼는다.
  function reconcileBitmapRig(s, rig, item, hadRest) {
    const sig = item.__evrSigBefore || rasterSig(item); // 열 때 넓혔으면 넓히기 전 그림의 요약(fillRasterToStage)
    delete item.__evrSigBefore;
    if (rig.sig?.abs === sig.abs) {
      const dx = Number.isFinite(rig.sig.x) ? sig.x - rig.sig.x : 0, dy = Number.isFinite(rig.sig.y) ? sig.y - rig.sig.y : 0;
      if (Math.abs(dx) > .01 || Math.abs(dy) > .01) {
        rig.joints = rig.joints.map(j => ({ ...j, x: clean(j.x + dx), y: clean(j.y + dy) }));
        if (rig.bitmap) Object.assign(rig.bitmap, { x: clean(rig.bitmap.x + dx), y: clean(rig.bitmap.y + dy) });
        rig.source = shiftPaths(rig.source, dx, dy);
        rig.sig = sig;
      }
      if (hadRest || !posed(rig)) return rig;
    }
    const points = jointPoints(rig);
    restCanvases.set(item, restHere(item));
    const base = bitmapRigBase(s, item, rig.joints.map(j => ({ ...j, x: clean(points[j.id].x), y: clean(points[j.id].y) })));
    base.sig = sig;
    return base;
  }
  // 모양 정보에 남긴 관절(십자 기준) → 지금 편집기 그림 좌표. 그림 데이터가 없을 때(PNG로 다시 연 모양) 쓴다.
  // 레이어가 여럿이면 지금 레이어가 파일에서 읽은 관절만 쓴다(모양 하나짜리 기록은 레이어를 모르니 다른 레이어에 붙는다).
  function savedBitmapJoints(s) {
    const meta = layerMeta(s.ep), own = meta && layerBonesOf(activeLayer(meta))?.joints;
    if (own) return own.map(j => ({ ...j }));
    if (meta && meta.layers.length > 1) return null;
    return pictureRigJoints(s);
  }
  function pictureRigJoints(c) {
    try {
      const saved = JSON.parse(c.picture?.dimension?.[BITMAP_RIG] || 'null'), center = crossPoint(c);
      if (!saved || !Array.isArray(saved.joints) || !saved.joints.length) return null;
      const joints = saved.joints.map(j => ({ id: j.id, parent: j.parent, x: clean(center.x + j.x), y: clean(center.y + j.y) }));
      return validRig({ joints, pose: {}, source: [], radius: 1 }) ? joints : null;
    } catch { return null; }
  }
  // 저장할 때 모양 정보에 남길 관절: 지금 자세 자리(휜 채로 저장하면 그 모양이 새 기준), 십자 기준 좌표
  function bitmapRigRecord(c, rig, rest) {
    const center = crossPoint(c), points = rest ? rig.joints : jointPoints(rig);
    return JSON.stringify({ joints: rig.joints.map(j => ({ id: j.id, parent: j.parent,
      x: clean(points[j.id].x - center.x), y: clean(points[j.id].y - center.y) })) });
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
        if (bitmapMode(p)) shiftLayerDisplays(p, move);
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
        if (pivotUI?.dragging?.id !== event.pointerId) return;
        const shift = pivotUI.dragging.layerShift;
        pivotUI.dragging = null;
        if (shift) try { commitLayerShift(pivotUI.ep, shift); } catch (error) { console.warn('[entry-vector-rig] 레이어 같이 옮기기', error); }
      };
      overlay.addEventListener('pointerup', stopDrag);
      overlay.addEventListener('pointercancel', stopDrag);
      overlay.addEventListener('lostpointercapture', stopDrag); // 놓기 없이 붙잡기만 풀려도 다른 레이어 옮김을 확정(검토 지적)
    }
    drawPivotUI();
  }
  // 그림 전체 이동(비트맵): 지금 레이어만 옮기면 레이어가 여럿일 때 그림이 갈라졌다(사용자 결정 10-18 — 모든 레이어를 같이). 끄는 동안은
  // 다른 레이어 표시 그림도 같이 옮기고(아래 묶음의 무대 틀은 그대로), 놓을 때 다른 레이어 그림 자리를 옮긴 만큼 확정한다.
  function shiftLayerDisplays(p, move) {
    const meta = layerMeta(p.ep);
    if (!meta || meta.layers.length < 2) return;
    for (const item of layerUi.displays) item.translate(move);
    layerUi.under?.children.slice(1).forEach(item => item.translate(move));
    const shift = p.dragging.layerShift ||= { x: 0, y: 0 };
    shift.x += move.x; shift.y += move.y;
  }
  function commitLayerShift(ep, shift) {
    const meta = layerMeta(ep);
    if (!meta || (!shift.x && !shift.y)) return;
    for (const layer of meta.layers) {
      // 파일에서 읽고 아직 안 연 레이어 관절도 같이 옮긴다(연 뼈대는 그림 자리가 바뀐 만큼 열 때 따라감 — reconcileBitmapRig)
      const kept = layerBonesOf(layer);
      if (kept?.joints && !kept.bones) {
        const ref = layerUid('b');
        layerBones.set(ref, { ...kept, joints: kept.joints.map(j => ({ ...j, x: clean(j.x + shift.x), y: clean(j.y + shift.y) })) });
        layer.bonesRef = ref;
      }
      const content = layer.id !== meta.active && layer.ref && layerCache.get(layer.ref);
      if (!content) continue;
      const ref = layerUid('r'); // 참조는 한 번 만들면 바꾸지 않는다(되돌리기 기록이 옛 참조를 씀)
      layerCache.set(ref, { canvas: content.canvas, x: content.x + shift.x, y: content.y + shift.y });
      layer.ref = ref;
    }
    layerUi.signature = null;
    refreshLayers(ep);
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
  // 비트맵 탭은 그림 층에 지금 레이어 한 장뿐이라 레이어 창 순서로 색을 매긴다(레이어를 바꿔도 그 레이어 색 그대로)
  const layerColor = (s, item) => {
    const meta = bitmapMode(s) && isRasterLayer(item) ? layerMeta(s.ep) : null;
    const index = meta ? meta.layers.findIndex(layer => layer.id === meta.active) : s.layers.indexOf(item);
    return LAYER_COLORS[Math.max(0, index) % LAYER_COLORS.length];
  };
  const bitmapLayerColor = (meta, layer) => LAYER_COLORS[Math.max(0, meta.layers.indexOf(layer)) % LAYER_COLORS.length];
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
      const root = [{ id: 0, parent: -1, x: clean(start.x), y: clean(start.y) }];
      rig = isRasterLayer(item) ? Object.assign(bitmapRigBase(s, item, root), { sig: rasterSig(item) }) :
        { joints: root, pose: {}, source: pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf)),
          radius: radiusOf(item), sig: shapeSig(item) };
      const parts = isRasterLayer(item) ? [] : groupParts(item);
      if (parts.length) rig.parts = parts.map(raster => partBase(s, raster));
      if ((isRasterLayer(item) || rig.parts) && !rig.source.length && !(rig.parts || []).some(part => part.source.length))
        throw Error('그림이 비어 있어 뼈를 넣을 수 없습니다.');
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
      if (isRasterLayer(item)) {
        renderBitmapPose(s, item, null);
        // 모양 정보에 남긴 관절도 지운다(저장할 때 그림에 뼈대 데이터가 없으면 기록을 그대로 두므로)
        if (s.picture?.dimension) delete s.picture.dimension[BITMAP_RIG];
        const meta = bitmapMode(s) && layerMeta(s.ep);
        if (meta) delete activeLayer(meta).bonesRef;
      } else {
        if (leaves.length === rig.source.length) leaves.forEach((leaf, i) => setWorldPathData(s.ep.paper, leaf, rig.source[i]));
        if (rig.parts) renderParts(s, item, null); // 묶음 안 그림도 휘기 전 그림으로
      }
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
    const all = rig.source.concat(...(rig.parts || []).map(part => part.source)), key = all.join('\n');
    let cached = s.restBounds.get(item);
    if (cached?.key !== key) {
      let bounds = null;
      for (const data of all) {
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
    if (rig) return restBounds(s, item, rig);
    // 비트맵 그림은 칸 크기 Raster라 칠해진 곳(휜 뒤면 휜 꼭짓점 범위)으로 잰다
    if (isRasterLayer(item)) {
      const held = s.rigs.get(item);
      return (held && posed(held) && s.cache.get(`bounds:${item.id}`)) || (held ? restBounds(s, item, held) : itemBounds(s, item));
    }
    return item.bounds;
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
  // 비트맵 탭: 그림 층에는 지금 레이어 한 장만 있고 나머지 레이어는 레이어 창 사본이다. 점에서 그 레이어의 불투명도(0~255).
  // 레이어 사본의 칠해진 범위와 그 안 불투명도 — 사본은 바뀌지 않으므로 한 번만 읽는다(마우스를 움직일 때마다 캔버스를 다시 읽지 않게)
  const inkMaps = new WeakMap();
  function layerInkOf(canvas) {
    if (inkMaps.has(canvas)) return inkMaps.get(canvas);
    const w = canvas.width, h = canvas.height, data = w && h ? canvas.getContext('2d').getImageData(0, 0, w, h).data : null;
    let left = w, top = h, right = -1, bottom = -1;
    for (let y = 0; data && y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= 8) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
    let ink = null;
    if (right >= 0) {
      const iw = right - left + 1, ih = bottom - top + 1, alpha = new Uint8Array(iw * ih);
      for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) alpha[y * iw + x] = data[((y + top) * w + x + left) * 4 + 3];
      ink = { left, top, w: iw, h: ih, alpha };
    }
    inkMaps.set(canvas, ink);
    return ink;
  }
  // 비트맵 탭: 그림 층에는 지금 레이어 한 장만 있고 나머지 레이어는 레이어 창 사본이다. 점에서 그 레이어의 불투명도(0~255).
  function bitmapAlphaAt(s, meta, layer, p) {
    if (layer.id === meta.active) {
      const raster = s.current && isRasterLayer(s.current) ? s.current : null;
      if (!raster?.width || !layer.visible) return 0;
      const local = raster.globalToLocal(new s.ep.paper.Point(p.x, p.y)).add([raster.width / 2, raster.height / 2]);
      const x = Math.floor(local.x), y = Math.floor(local.y);
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
      return raster.getImageData(new s.ep.paper.Rectangle(x, y, 1, 1)).data[3];
    }
    const content = layerContent(s.ep, meta, layer), ink = content && layerInkOf(content.canvas);
    if (!ink) return 0;
    const x = Math.floor(p.x - content.x) - ink.left, y = Math.floor(p.y - content.y) - ink.top;
    return x < 0 || y < 0 || x >= ink.w || y >= ink.h ? 0 : ink.alpha[y * ink.w + x];
  }
  // 점에 보이는 다른 비트맵 레이어(위부터, 클리핑 레이어는 기준이 칠해진 곳만 — 맨 아래 클리핑 레이어는 그 자신이 기준). 지금 레이어가
  // 칠해진 곳이면 null — 그 위에서는 평소처럼 뼈를 다룬다.
  function bitmapLayerAt(s, p) {
    const meta = bitmapMode(s) ? layerMeta(s.ep) : null, ink = 8;
    if (!meta || meta.layers.length < 2 || bitmapAlphaAt(s, meta, activeLayer(meta), p) > ink) return null;
    for (let i = meta.layers.length - 1; i >= 0; i--) {
      const layer = meta.layers[i];
      if (layer.id === meta.active || !layer.visible || !(layer.opacity > 0) || bitmapAlphaAt(s, meta, layer, p) <= ink) continue;
      if (layer.clip) {
        let base = null;
        for (let j = i - 1; j >= 0 && !base; j--) if (!meta.layers[j].clip) base = meta.layers[j];
        if (base && (!base.visible || !(base.opacity > 0) || bitmapAlphaAt(s, meta, base, p) <= ink)) continue;
      }
      return layer;
    }
    return null;
  }
  // 지금 비트맵 레이어의 칠해진 범위 근처인가(첫 뼈를 그 그림 둘레에서 시작할 수 있게 — 그림 층은 작업 영역만큼 넓혀 두어 늘 둘레 안이다)
  function nearCurrentInk(s, p) {
    const raster = s.current && isRasterLayer(s.current) ? s.current : null;
    if (!raster?.width) return false;
    const ink = layerInkOf(raster.getSubCanvas ? raster.getSubCanvas(new s.ep.paper.Rectangle(0, 0, raster.width, raster.height)) : raster.canvas);
    if (!ink) return false;
    const pad = 24 / (s.ep.paper.view.zoom || 1), b = raster.bounds;
    return p.x >= b.left + ink.left - pad && p.x <= b.left + ink.left + ink.w + pad && p.y >= b.top + ink.top - pad && p.y <= b.top + ink.top + ink.h + pad;
  }
  // 다른 비트맵 레이어의 칠해진 범위(화면 사각형) — 가리킨 레이어를 점선으로 두를 때
  function bitmapLayerRect(s, layer) {
    const meta = layerMeta(s.ep), content = meta && layerContent(s.ep, meta, layer), ink = content && layerInkOf(content.canvas);
    if (!ink) return null;
    const x = content.x + ink.left, y = content.y + ink.top;
    const a = screen(s, { x, y }), z = screen(s, { x: x + ink.w, y: y + ink.h });
    return { x: Math.min(a.x, z.x), y: Math.min(a.y, z.y), width: Math.abs(z.x - a.x), height: Math.abs(z.y - a.y) };
  }
  // 뼈대 모드에서 다른 비트맵 레이어로: 지금 레이어 뼈대는 고칠 때마다 그림 data에 남아 있고(persist) 레이어를 바꾸면 레이어 쪽으로
  // 옮겨진다(storeActive). 레이어를 바꾼 뒤 그 레이어로 다시 연다(벡터처럼 뼈대 모드를 끄지 않고 누르기만으로).
  function switchBitmapLayer(s, layer) {
    const meta = layerMeta(s.ep), ep = s.ep, opener = s.opener;
    if (!meta || !layer || meta.active === layer.id || s.dragging) return;
    close();
    selectBitmapLayer(ep, layer.id);
    try { const c = context(); if (c) open(c, opener); }
    catch (error) { toast(error.message || String(error), 4000); }
  }
  // 고른 레이어 둘레(조금 넓게) 안인가.
  function nearCurrent(s, p) {
    if (!s.current) return false;
    const pad = 12 / (s.ep.paper.view.zoom || 1), b = layerBounds(s, s.current);
    return p.x >= b.left - pad && p.x <= b.right + pad && p.y >= b.top - pad && p.y <= b.bottom + pad;
  }
  // 만들기 단계에서 덮개 위에 그리는 고른 레이어의 휘기 전 모양(제 색). 경로 요소는 기준 모양이 바뀔 때만 새로 만든다.
  function restPreview(s, item) {
    if (isRasterLayer(item)) return restImagePreview(s, item);
    const rig = s.rigs.get(item), data = rig ? rig.source : pathItems(item).map(leaf => worldPathData(s.ep.paper, leaf));
    // 묶음 안 그림은 휘기 전 그림을 그 자리에(경로 아래)
    const pictures = groupParts(item).map((raster, i) => ({ raster, rest: restCanvasOf(raster),
      at: rig?.parts?.[i]?.bitmap || restCanvases.get(raster)?.at || partRestHere(raster).at }));
    const key = data.join('\n') + pictures.map(p => `|${restUrlOf(p.raster)?.length}:${p.at.x},${p.at.y}`).join('');
    let cached = s.previews.get(item);
    if (cached?.key !== key) {
      const group = svg('g', { class: 'evr-rig-rest' }), leaves = pathItems(item);
      for (const p of pictures) if (p.rest) group.append(svg('image', { href: restUrlOf(p.raster), x: p.at.x, y: p.at.y, width: p.rest.width, height: p.rest.height,
        preserveAspectRatio: 'none', ...(objectPixel(s.object) > 0 ? { style: 'image-rendering:pixelated' } : {}) }));
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
  // 비트맵 만들기 단계: 덮개 위에 휘기 전 그림을 그 자리에(뷰 행렬로) 그린다.
  function restImagePreview(s, item) {
    const rig = s.rigs.get(item), b = item.bounds, at0 = rig?.bitmap || { x: b.left, y: b.top };
    const rest = restCanvasOf(item), key = `${restUrlOf(item)?.length}:${at0.x},${at0.y}`;
    let cached = s.previews.get(item);
    if (cached?.key !== key) {
      const group = svg('g', { class: 'evr-rig-rest' });
      if (rest) group.append(svg('image', { href: restUrlOf(item), x: at0.x, y: at0.y, width: rest.width, height: rest.height,
        preserveAspectRatio: 'none', ...(objectPixel(s.object) > 0 ? { style: 'image-rendering:pixelated' } : {}) }));
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
    const hoverMeta = s.hoverLayer && layerMeta(s.ep), hoverLayer = hoverMeta?.layers.find(layer => layer.id === s.hoverLayer);
    const hoverRect = hoverLayer && hoverLayer.id !== hoverMeta.active && bitmapLayerRect(s, hoverLayer);
    if (hoverRect) s.overlay.append(svg('rect', { class: 'evr-rig-piece', 'data-kind': 'hover', x: hoverRect.x - 3, y: hoverRect.y - 3,
      width: hoverRect.width + 6, height: hoverRect.height + 6, stroke: bitmapLayerColor(hoverMeta, hoverLayer) }));
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
  // 비트맵 레이어가 여럿이면 목록은 레이어 창 레이어 모두(아래부터 — 벡터 목록과 같은 순서). 다른 레이어 줄을 누르면 그 레이어로 바꾼다.
  function bitmapRigRows(s, meta) {
    return meta.layers.map(layer => {
      const active = layer.id === meta.active, rig = active ? s.rigs.get(s.current) : null, kept = active ? null : layerBonesOf(layer);
      let count = rig ? rig.joints.length : 0;
      if (kept) { try { count = (kept.bones ? JSON.parse(kept.bones).joints : kept.joints)?.length || 0; } catch { count = 0; } }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'evr-rig-layer';
      row.dataset.picked = String(active);
      const swatch = document.createElement('span');
      swatch.className = 'evr-rig-swatch';
      swatch.style.background = bitmapLayerColor(meta, layer);
      const name = document.createElement('span');
      name.className = 'evr-rig-name';
      name.textContent = layer.name;
      const bones = document.createElement('span');
      bones.className = 'evr-rig-bone-label';
      bones.textContent = count > 1 ? `관절 ${count}` : '뼈대 없음';
      row.append(swatch, name, bones);
      const empty = !active && !layerContent(s.ep, meta, layer);
      row.disabled = empty;
      row.title = empty ? '빈 레이어라 뼈를 넣을 수 없습니다' : '이 레이어를 골라 뼈를 그리고 휩니다';
      row.addEventListener('mouseenter', () => { s.hoverLayer = active ? null : layer.id; draw(s); });
      row.addEventListener('mouseleave', () => { s.hoverLayer = null; draw(s); });
      row.addEventListener('click', () => active ? selectLayer(s, s.current) : switchBitmapLayer(s, layer));
      return row;
    });
  }
  function refreshRigUI(s) {
    if (!s.ui) return;
    const meta = bitmapMode(s) && s.current ? layerMeta(s.ep) : null;
    if (meta && meta.layers.length > 1) s.ui.layers.replaceChildren(...bitmapRigRows(s, meta));
    else s.ui.layers.replaceChildren(...s.layers.map((item, index) => {
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
      name.textContent = item.name || (isRasterLayer(item) ? '그림' : `레이어 ${index + 1}`);
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
    if (!s.layers.length) s.ui.layers.append(text('p', bitmapMode(s) ? '그림이 비어 있습니다' : '벡터 도형이나 그림이 없습니다'));
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
        // 비트맵 그림 층은 작업 영역만큼 넓혀 두어 늘 지금 레이어 둘레 안이다 — 다른 레이어의 칠해진 곳이면 그 레이어로 바꾸되,
        // 뼈대가 없는 지금 레이어 그림 근처에서 누르면 첫 뼈를 시작한다(뿌리를 그림 바로 밖에 둘 수 있게)
        const pick = bitmapLayerAt(s, p);
        const startHere = setup && s.current && !rig && (pick ? nearCurrentInk(s, p) : nearCurrent(s, p));
        if (pick && !startHere) return switchBitmapLayer(s, pick);
        if (startHere) {
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
        const p = pointer(s, event);
        let pick = null;
        try { pick = bitmapLayerAt(s, p); } catch (error) { pick = null; } // 가리키기 표시가 실패해도 매 움직임 오류로 번지지 않게
        const other = pick || nearCurrent(s, p) ? null : layerAt(s, p);
        const hover = other && other !== s.current ? other : null, hoverLayer = pick ? pick.id : null;
        if (hover !== s.hover || hoverLayer !== (s.hoverLayer || null)) {
          s.hover = hover;
          s.hoverLayer = hoverLayer;
          s.overlay.dataset.cursor = hover || hoverLayer ? 'pick' : '';
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
      if (s.dragging || !(s.hover || s.hoverLayer)) return;
      s.hover = null;
      s.hoverLayer = null;
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
  // ---- 엔트리 선택 윤곽선 다시 맞추기 ----
  // 같은 까닭으로 확장이 고른 도형을 엔트리 모르게 옮기거나(그림 전체 이동·십자 맞추기·캔버스 크기 등) 숨기거나 그림에서 빼면 옛 윤곽선과
  // 변형 상자가 그 자리에 남는다(사용자 화면 "박스 남음" — 실제 엔트리에서 그림 전체 이동 뒤 41개 모두 옛 자리). 도형을 바꾸는 곳마다 막는
  // 대신, 고른 도형의 윤곽선이 지금 도형과 어긋났으면 선택을 다시 해 엔트리가 새로 그리게 한다. 엔트리는 윤곽선이 이미 있으면 그대로 쓰므로
  // (activateItem) 먼저 비우고 같은 것을 다시 고른다. 숨겼거나 그림에서 빠진 도형은 선택에서 뺀다. 누르고 있는 동안(엔트리 끌기 중)은
  // 건드리지 않는다. 윤곽선은 고를 때 도형의 전역 위치로 만든 복제본이라 둘 다 전역 범위로 견준다(getBounds(전역 행렬)).
  let pointerHeld = false;
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { pointerHeld = false; }, true);
  const sameBox = (a, b) => Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5 &&
    Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;
  const globalBox = item => item.getBounds(item.globalMatrix);
  function entryOutlinesStale(layer, items) {
    for (const unit of items) {
      if (!unit?.isInserted?.() || !unit.isDescendant(layer) || !unit.visible) return true;
      for (const leaf of unit.children ? unit.getItems({ match: item => !item.children }) : [unit]) {
        const guide = leaf.data?.guideItem;
        if (guide?.isInserted?.() && !sameBox(globalBox(guide), globalBox(leaf))) return true;
      }
    }
    return false;
  }
  function resyncEntrySelection(ep) {
    const store = paintStore(), layer = paintLayer(ep)?.layer;
    const state = store?.getState();
    if (!layer || state?.tool?.toolMode !== 'SELECT') return false;
    const items = state.paint?.selectedItems || [];
    if (!items.length) return false;
    const keep = items.filter(item => item?.isInserted?.() && item.isDescendant(layer) && item.visible);
    store.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    store.dispatch({ type: 'SELECT_ITEMS', payload: keep });
    return true;
  }
  // 다시 고른 직후에도 같은 모습으로 어긋나 보이면(견주는 방식이 맞지 않는 도형) 다시 하지 않는다 — 0.5초마다 다시 고르며 깜빡이지 않게.
  // 같은 선택이어도 도형이 또 옮겨졌으면(자리 요약이 다름) 다시 맞춘다(선택 배열만 보면 두 번째 이동을 놓쳤다 — 검토로 찾음).
  let healedShape = null;
  const selectionShape = items => items.map(unit => {
    if (!unit?.isInserted?.()) return 'x';
    const b = globalBox(unit);
    return `${unit.id}:${unit.visible ? 1 : 0}:${[b.x, b.y, b.width, b.height].map(v => Math.round(v)).join(',')}`;
  }).join('|');
  function healEntryOutlines(ep) {
    if (pointerHeld || session || ep?.mode !== 'VECTOR') return;
    const store = paintStore(), layer = paintLayer(ep)?.layer;
    const state = store?.getState();
    if (!layer || state?.tool?.toolMode !== 'SELECT') return;
    const items = state.paint?.selectedItems || [];
    if (!items.length) return;
    if (!entryOutlinesStale(layer, items)) { healedShape = null; return; }
    const shape = selectionShape(items);
    if (shape === healedShape) return; // 이 모습으로는 다시 골라도 맞지 않았다
    if (resyncEntrySelection(ep)) healedShape = shape;
  }
  function open(c, opener) {
    if (session) close();
    if (!c.layer.children.length) throw Error(bitmapMode(c) ? '그림이 비어 있습니다.' : '벡터 모양이 비어 있습니다.');
    clearEntrySelection(c);
    if (bitmapMode(c)) {
      // 엔트리 선택을 풀면 잘라 든 조각이 그림에 합쳐진다. 그 뒤 그림 한 장을 칸만큼 넓혀 둔다.
      // 넓히기 전에 검사한다(넓히기는 행렬을 빼고 원래 화소로 다시 그려, 크기를 바꾸거나 돌린 그림이 말없이 되돌아갔다)
      const first = c.layer.children.find(isRasterLayer);
      if (first && !plainRaster(first)) throw Error('크기를 바꾸거나 돌리거나 뒤집은 비트맵이라 뼈대를 쓸 수 없습니다. 저장한 뒤 다시 열어 주세요.');
      const raster = fillRasterToStage(c);
      if (!raster || rasterInk(raster) === null) throw Error('그림이 비어 있습니다.');
      // 휜 채로 남긴 휘기 전 그림(data URL)은 그림으로 읽은 뒤 연다.
      const url = raster.data?.[BITMAP_REST];
      if (url && !restCanvasOf(raster)) {
        const image = new Image();
        image.onload = () => {
          const canvas = canvasOfSize(image.naturalWidth, image.naturalHeight);
          canvas.getContext('2d').drawImage(image, 0, 0);
          restCanvases.set(raster, { canvas, url });
          if (!session) try { open(context() || c, opener); } catch (error) { window.alert(error.message || String(error)); }
        };
        image.onerror = () => { delete raster.data[BITMAP_REST]; if (!session) open(context() || c, opener); };
        image.src = url;
        return;
      }
    } else {
      // 벡터 탭 그림 레이어도 휜 채 남긴 휘기 전 그림을 다 읽은 뒤 연다
      const waiting = c.layer.getItems({ match: item => isRasterLayer(item) && item.data?.[BITMAP_REST] && !restCanvasOf(item) }); // 묶음 안 그림 포함
      if (waiting.length) {
        let left = waiting.length;
        const done = () => { if (--left === 0 && !session) try { open(context() || c, opener); } catch (error) { window.alert(error.message || String(error)); } };
        for (const raster of waiting) {
          const url = raster.data[BITMAP_REST], image = new Image();
          image.onload = () => {
            const canvas = canvasOfSize(image.naturalWidth, image.naturalHeight);
            canvas.getContext('2d').drawImage(image, 0, 0);
            restCanvases.set(raster, { canvas, url, at: savedRestAt(raster) || partRestAt(c, raster) });
            done();
          };
          image.onerror = () => { delete raster.data[BITMAP_REST]; done(); };
          image.src = url;
        }
        return;
      }
    }
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
          else { const c = context(); if (c) open(c, mode); } // 모양을 바꾸는 틈에는 열지 않음
        } catch (error) { window.alert(error.message || String(error)); }
      });
      wrap.append(mode);
    }
    // 묶음 뒤 같은 줄에 있으면 그대로 둔다. "바로 뒤" 자리를 고집하면 같은 방식을 쓰는 다른 확장과
    // 서로 계속 자리를 바꾸게 된다. 바로 뒤일 때만 세 번째 칸처럼 붙어 보인다(CSS).
    if (wrap.parentElement !== space.parentElement ||
        !(space.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING)) space.after(wrap);
    const disabled = !c.layer.children.length;
    if (mode.disabled !== disabled) mode.disabled = disabled;
    mode.title = disabled ? '그림이 비어 있습니다' : bitmapMode(c) ?
      '뼈대 모드: [뼈 만들기]에서 뼈를 그리고 [자세 잡기]에서 끌어 비트맵 그림을 휩니다(칠해진 곳만 따라 휨)' :
      '뼈대 모드: [뼈 만들기]에서 뼈를 그리고 [자세 잡기]에서 끌어 벡터 그림을 휩니다(그림 레이어는 칠해진 곳만 따라 휨)';
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
  // 캔버스를 키워 작업 영역이 캔버스(2400×1350)보다 크게 보이면 250% 이하에서도 같다(엔트리 도구는 상자만 옮겨 끝까지 못 감).
  function entryHandTool(parts) {
    const tool = parts.paper.tool, { stage, view, canvas } = parts;
    const beyond = !!stage && ((stage.right - stage.left) * view.zoom > canvas.offsetWidth + .5 ||
      (stage.bottom - stage.top) * view.zoom > canvas.offsetHeight + .5);
    return (view.zoom > ENTRY_ZOOM_MAX + 1e-9 || beyond) && tool?.targetEl === parts.box && 'dragMax' in tool;
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
      // 그림판 칸 안에 띄운 확장 창(레이어 창·투명도 상자·그라데이션 창)은 화면 이동으로 가로채지 않는다 — 손 도구·스페이스일 때 창의 단추·밀대가
      // 눌리지 않았다(검토로 찾음 2026-10-16)
      if (event.target?.closest?.('.evr-layers, .evr-opacity-opts, .evr-grad-win')) return;
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
  // ---- 캔버스 크기(작업 영역)·무한 배경 ----
  // 엔트리 그림판(entry-paint 260921)은 2400×1350 캔버스 가운데 무대(960×540)만 보이게 자르고(무대 크기 틀로 잘라 보이는
  // 층), 비트맵은 획을 마칠 때·저장할 때(getDataURL)·벡터에서 바꿀 때 "무대 사각형" 밖을 잘라 낸다. 무대 사각형은 처음에
  // 배경 레이어 bounds를 한 번 잰 LinkedRectangle(_owner = 배경 레이어)이라, 엔트리가 그 사각형으로 자를 때(intersect)
  // 붙잡아 값만 작업 영역으로 바꾼다(알림 없는 _set — 배경 레이어는 움직이지 않음). 그러면 엔트리 자르기가 모두 따라오고,
  // 배경 바둑판·잘라 보이는 틀·화면 이동 범위는 확장이 같이 넓힌다. 작업 영역 가운데는 늘 처음 중심(home)이라 엔트리가 모양
  // 그림을 놓는 자리(view.center)와 맞는다. 확장이 꺼진 엔트리에서도 큰 모양은 실행 화면에 그대로 보이지만, 그림판에서
  // 비트맵을 고치면 무대 밖이 잘린다(엔트리 원래 동작).
  // 무한 배경 = Aseprite 타일 모드(filters::TiledMode NONE·X_AXIS·Y_AXIS·BOTH, app/util/tiled_mode.cpp): 작업 영역을 한 칸으로
  // 보고 둘레(가로·세로·둘 다)에 같은 그림을 이어 보여 준다. 비트맵은 칸 밖으로 넘어간 붓·도형·지우개를 칸 크기만큼 옮긴
  // 자리(반대쪽)에도 그린다 — Aseprite collapseRegionByTiledMode·wrap_value와 같은 규칙. 벡터는 도형을 고치지 않고, 칸 끝을 넘은
  // 도형을 칸 크기만큼 옮긴 사본을 칸 안에 보여 주고(잠김, 그림 층 밖), 저장 PNG는 비트맵과 같이 칸 그대로 접어 굽는다.
  // 크기 한도: 가로로 긴 맵(예: 8000×540)도 넣게 한 변은 16384까지, 대신 그림 한 장이 너무 무거워지지 않게 전체 화소는 4096×4096까지
  // (엔트리는 획마다 그림 층 전체를 다시 구움).
  const AREA_DEFAULT = { w: 960, h: 540 }, AREA_MIN = 16, AREA_MAX = 16384, AREA_MAX_PIXELS = 4096 * 4096;
  const areaFits = (w, h) => w >= AREA_MIN && h >= AREA_MIN && w <= AREA_MAX && h <= AREA_MAX && w * h <= AREA_MAX_PIXELS;
  const WRAP_AXES = { none: [0, 0], x: [1, 0], y: [0, 1], both: [1, 1] };
  const WRAP_LABELS = { none: '끄기', x: '가로', y: '세로', both: '가로·세로' };
  // ep: 이 상태가 가리키는 편집기, bg: 배경 레이어, stageRect: 붙잡은 엔트리 무대 사각형, size: 작업 영역(기본이면 null),
  // wrap: 무한 배경 방향, fileId: 지금 모양, copies/frame: 둘레 그림·칸 테두리, signature: 둘레 그림을 다시 그릴지 판단
  // home: 처음 무대 가운데(편집기를 처음 볼 때 무대 틀에서 잼 — 화면 이동용 painterHome을 거치지 않아 서로 부르는 고리가 없다),
  // mode: 마지막으로 맞춘 비트맵·벡터, backdrop: 벡터 무한 배경 둘레 바둑판
  const areaState = { ep: null, bg: null, stageRect: null, size: null, wrap: 'none', fileId: undefined,
    copies: null, frame: null, backdrop: null, twins: null, signature: '', home: null, mode: null };
  const areaChoices = new Map(); // 모양 id → 사용자가 고른 { w, h, wrap } (이 탭 동안만)
  const areaHome = ep => (areaState.ep === ep && areaState.home) || { x: 1200, y: 675 };
  const areaRect = (ep, w, h) => {
    const home = areaHome(ep);
    return new ep.paper.Rectangle(Math.round(home.x - w / 2), Math.round(home.y - h / 2), w, h);
  };
  // 가운데 한 칸(그림 칸). 기본 크기·무한 배경 끔이면 null(엔트리 그대로).
  function areaTile(ep) {
    if (!ep || areaState.ep !== ep || (!areaState.size && areaState.wrap === 'none')) return null;
    const { w, h } = areaState.size || AREA_DEFAULT;
    return areaRect(ep, w, h);
  }
  const bitmapWrap = ep => ep.mode === 'BITMAP' && wrapOn(ep);
  const wrapAxes = ep => areaState.ep === ep ? WRAP_AXES[areaState.wrap] || WRAP_AXES.none : WRAP_AXES.none;
  const wrapOn = ep => { const [x, y] = wrapAxes(ep); return !!(x || y); };
  // 칸 옆에 이어 붙이는 자리(칸 크기 배수). 가운데(0,0)는 뺀다.
  function wrapOffsets(ep, tile) {
    const [ax, ay] = wrapAxes(ep), offsets = [];
    for (const dy of ay ? [-1, 0, 1] : [0]) for (const dx of ax ? [-1, 0, 1] : [0])
      if (dx || dy) offsets.push([dx * tile.width, dy * tile.height]);
    return offsets;
  }
  // paper Rectangle에는 옮기기가 없다. clone은 연결 없는 보통 Rectangle을 돌려준다(item.bounds도 안전).
  const shiftRect = (rect, dx, dy) => { const moved = rect.clone(); moved.x += dx; moved.y += dy; return moved; };
  // 보이는 범위 = 그림 칸 + 무한 배경 둘레
  function areaDisplay(ep, tile) {
    const [ax, ay] = wrapAxes(ep);
    return new ep.paper.Rectangle(tile.x - ax * tile.width, tile.y - ay * tile.height,
      tile.width * (1 + 2 * ax), tile.height * (1 + 2 * ay));
  }
  // 엔트리 그림판 층: 바탕(묶음) 안 [배경 레이어(잠김), 잘라 보이는 층(틀 + 그림 층), 안내 층]
  function stageParts(ep) {
    const layers = ep.project.getItems({ class: ep.paper.Layer }).filter(layer =>
      layer.parent?.className === 'Layer' && layer.parent.children.some(sibling => sibling.className === 'Shape'));
    if (layers.length !== 1) return null;
    const paint = layers[0], clip = paint.parent, root = clip.parent;
    const mask = clip.children.find(item => item.className === 'Shape');
    const bg = root?.children?.find(item => item !== clip && item.className === 'Layer' && item.locked);
    return mask && bg ? { paint, clip, root, mask, bg } : null;
  }
  // 엔트리가 무대 사각형으로 자를 때 붙잡아 작업 영역 값을 넣는다. 처음 붙잡기 전에는 엔트리 값 그대로다.
  function hookStageRect(paper) {
    const proto = paper.Rectangle.prototype;
    if (own(proto, '__evrStage')) return;
    Object.defineProperty(proto, '__evrStage', { value: true });
    const original = proto.intersect;
    proto.intersect = function (rect, ...rest) {
      if (rect && areaState.bg && rect._owner === areaState.bg && typeof rect._set === 'function') {
        areaState.stageRect = rect;
        applyStageRect();
      }
      return original.call(this, rect, ...rest);
    };
  }
  // run을 부르는 동안 Math.max/min 첫 몇 번의 경계만 바꾼다. edges는 엔트리가 부르는 차례대로 [함수, 경계가 든 인자 자리, 엔트리 경계,
  // 바꿀 경계, 다른 인자(끄는 점 좌표)]. 다른 인자까지 같아야 바꾼다 — 그 사이 paper 내부가 우연히 같은 경계로 Math를 불러도 건드리지
  // 않게. 차례·값이 어긋나면(엔트리가 바뀜) 그 자리에서 원래 Math로 돌려 엔트리 그대로 둔다. 엔트리가 모듈 안 상수로 끄는 점을 묶는
  // 곳(아래 두 곳)에 쓴다 — 상수를 밖에서 바꿀 길이 없다(entry-paint 261015 소스로 확인).
  function callWithEdges(edges, run) {
    const { max, min } = Math;
    let step = 0;
    const restore = () => { Math.max = max; Math.min = min; };
    const pick = which => function (...args) {
      const [want, at, limit, wide, other] = edges[step] || [];
      if (want !== which || args.length !== 2 || args[at] !== limit || args[1 - at] !== other) { restore(); return which.apply(Math, args); }
      if (++step === edges.length) restore();
      args[at] = wide;
      return which(...args);
    };
    Math.max = pick(max); Math.min = pick(min);
    try { return run(); } finally { restore(); }
  }
  // 엔트리 선택 이동(entry-paint 261015 Mt.onMouseDrag)은 끄는 점을 xt.getValidMousePoint로 옛 무대(모듈 안 상수 ue.minX..maxY
  // = 720..1680, 405..945)에 묶어, 캔버스를 키우면 옛 무대 밖으로 옮길 수 없었다(사용자 제보 2026-10-16, 벡터·비트맵 모두 재현 — 1900까지
  // 끌면 1680에서 멈춤). 그 함수가 view.on('mousedrag')로 붙을 때 감싸, 첫 묶기 네 번(Math.max(x, minX), Math.min(·, maxX), y도 같은
  // 차례)의 경계만 지금 배경 범위로 바꿔 부른다.
  const moveDrags = new WeakMap();
  function hookMoveClamp(ep) {
    const view = ep.project?.view;
    if (!view || own(view, '__evrMoveClamp') || typeof view.on !== 'function' || typeof view.off !== 'function') return;
    Object.defineProperty(view, '__evrMoveClamp', { value: true });
    const on = view.on, off = view.off;
    view.on = function (type, fn, ...rest) {
      if (type !== 'mousedrag' || typeof fn !== 'function' || !String(fn).includes('getValidMousePoint')) return on.call(this, type, fn, ...rest);
      let wrapped = moveDrags.get(fn);
      if (!wrapped) {
        wrapped = function (event, ...args) {
          // 범위 = 옛 무대와 지금 배경을 합친 것(작은 캔버스에서 예전보다 좁아지지 않게). 끌 때마다 그림판을 훑지 않게 붙잡아 둔 배경 층을 쓴다
          const bg = areaState.ep === ep && areaState.bg?.bounds, old = areaRect(ep, AREA_DEFAULT.w, AREA_DEFAULT.h), p = event?.point;
          if (!bg || !p || old.contains(bg)) return fn.call(this, event, ...args);
          const left = Math.min(old.left, bg.left), right = Math.max(old.right, bg.right), top = Math.min(old.top, bg.top), bottom = Math.max(old.bottom, bg.bottom);
          const { max, min } = Math;
          return callWithEdges([[max, 1, old.left, left, p.x], [min, 1, old.right, right, Math.max(p.x, left)],
            [max, 1, old.top, top, p.y], [min, 1, old.bottom, bottom, Math.max(p.y, top)]], () => fn.call(this, event, ...args));
        };
        moveDrags.set(fn, wrapped);
      }
      return on.call(this, type, wrapped, ...rest);
    };
    view.off = function (type, fn, ...rest) {
      return off.call(this, type, (type === 'mousedrag' && moveDrags.get(fn)) || fn, ...rest);
    };
  }
  // 엔트리 사각형·원 도구(entry-paint 261015 Wr.doing)는 끄는 점을 Math.max(0, x)·Math.max(0, y)로 캔버스 원점에 묶어, 캔버스를 2400보다
  // 넓히거나(가로 3배 등) 비트맵 무한 배경을 켜서 배경이 0보다 왼쪽·위로 넓어지면 그쪽으로는 도형을 키울 수 없었다(검토로 찾음 2026-10-16).
  // 두 도구의 끌기를 감싸 배경이 0 밖으로 나갈 때만 그 두 경계를 배경 끝으로 바꾼다.
  const shapeDragTools = new WeakSet(); // 도구마다 한 번만 감싼다(다른 확장이 위에 또 감싸도 0.5초마다 쌓이지 않게)
  function hookShapeDrag(ep) {
    for (const tool of ep.paper?.tools || []) {
      const mode = tool.MY_MODE?.toolMode;
      if ((mode !== 'RECT' && mode !== 'ELLIPSE') || typeof tool.onMouseDrag !== 'function' || shapeDragTools.has(tool)) continue;
      shapeDragTools.add(tool);
      const original = tool.onMouseDrag;
      const wrapped = function (event, ...args) {
        const bounds = areaState.ep === ep && areaState.bg?.bounds;
        if (!bounds || (bounds.left >= 0 && bounds.top >= 0)) return original.call(this, event, ...args);
        const { max } = Math, p = event?.point;
        if (!p) return original.call(this, event, ...args);
        return callWithEdges([[max, 0, 0, Math.min(0, bounds.left), p.x], [max, 0, 0, Math.min(0, bounds.top), p.y]], () => original.call(this, event, ...args));
      };
      tool.onMouseDrag = wrapped;
    }
  }
  // 비트맵 무한 배경은 둘레(칸 3배)까지 — 엔트리가 둘레에 그린 것을 자르지 않고, 그림 층에 들어올 때 칸으로 접는다(hookPaintLayer).
  function applyStageRect() {
    const rect = areaState.stageRect, ep = areaState.ep;
    if (!rect || !ep) return;
    const tile = areaTile(ep) || areaRect(ep, AREA_DEFAULT.w, AREA_DEFAULT.h);
    const r = bitmapWrap(ep) ? areaDisplay(ep, tile) : tile;
    if (rect._x !== r.x || rect._y !== r.y || rect._width !== r.width || rect._height !== r.height)
      rect._set(r.x, r.y, r.width, r.height, true);
  }
  // 엔트리 배경(흰 바탕 + 6px 바둑판, entry-paint 무대 레이어 만들기와 같은 점 순서)을 rect 크기로 다시 만든다.
  function rebuildBackground(paper, bg, rect) {
    bg.removeChildren();
    bg.addChildren(backgroundItems(paper, rect));
  }
  function backgroundItems(paper, rect) {
    const { width, height } = rect;
    const white = new paper.Shape.Rectangle({ point: [0, 0], size: [width, height], fillColor: '#fff', insert: false });
    const points = [];
    let x = 0, y = 0;
    while (y < height) {
      points.push(new paper.Point(x, y)); x = x === 0 ? width : 0; points.push(new paper.Point(x, y));
      y += 6; if (y > height) y = height;
    }
    for (x = 0, y = height; x < width;) {
      points.push(new paper.Point(x, y)); x += 6; if (x > width) x = width; points.push(new paper.Point(x, y));
      y = y === 0 ? height : 0;
    }
    const checker = new paper.Path({ segments: points, fillRule: 'evenodd', fillColor: '#ccc', insert: false });
    white.locked = checker.locked = true;
    white.translate(rect.x, rect.y);
    checker.translate(rect.x, rect.y);
    return [white, checker];
  }
  // 작업 영역·무한 배경을 편집기에 반영한다(크기는 짝수로 맞춘다 — 가운데가 정수 칸에 놓이게).
  function setArea(ep, w, h, wrap) {
    const parts = stageParts(ep);
    if (!parts) return false;
    const even = value => Math.max(AREA_MIN, Math.min(AREA_MAX, Math.round(value / 2) * 2));
    w = even(w); h = even(h);
    if (w * h > AREA_MAX_PIXELS) { // 비율 그대로 한도까지 줄인다
      const k = Math.sqrt(AREA_MAX_PIXELS / (w * h));
      w = Math.max(AREA_MIN, Math.floor(w * k / 2) * 2); h = Math.max(AREA_MIN, Math.floor(h * k / 2) * 2);
    }
    areaState.size = w === AREA_DEFAULT.w && h === AREA_DEFAULT.h ? null : { w, h };
    areaState.wrap = WRAP_AXES[wrap] ? wrap : 'none';
    areaState.mode = ep.mode;
    applyStageRect();
    const tile = areaTile(ep) || areaRect(ep, AREA_DEFAULT.w, AREA_DEFAULT.h);
    const display = areaDisplay(ep, tile);
    // 배경 레이어·잘라 보이는 틀: 비트맵 무한 배경은 둘레까지(둘레에 그리는 획도 보이고 그릴 수 있게), 그 밖은 그림 칸.
    // 엔트리는 그리기 시작 자리를 배경 레이어 범위로 검사하므로(entry-paint Gn), 벡터 무한 배경은 배경을 칸으로 두어 둘레에서는
    // 그리지 않게 한다(둘레에 그린 벡터는 보이지 않는데 저장되었다 — 검토로 찾음). 벡터 둘레 바둑판은 따로 그린다(drawWrapExtras).
    const shown = bitmapWrap(ep) ? display : tile;
    rebuildBackground(ep.paper, parts.bg, shown);
    parts.mask.set({ size: [shown.width, shown.height], position: shown.center });
    const found = painterHome(ep);
    if (found) found.stage = { left: display.left, right: display.right, top: display.top, bottom: display.bottom };
    areaState.signature = '';
    drawWrapExtras(ep, parts, tile);
    afterPainterView();
    return true;
  }
  // 무한 배경 사본은 그림 층 밖이라 자르기 그리기(hookClipDraw)를 타지 않는다. 기준과 그 위 클리핑 레이어 사본을 따로 합성하는 묶음으로
  // 싸고 클리핑 사본에 source-atop을 걸어 같은 모습으로 둔다. entries: 차례대로 { clip, nodes }
  function clipRunGroups(paper, entries) {
    const out = [];
    let run = null;
    const close = () => {
      if (!run) return;
      if (run.clipped) {
        const group = new paper.Group({ insert: false, children: run.nodes });
        group.opacity = CLIP_ISOLATE;
        out.push(group);
      } else out.push(...run.nodes);
      run = null;
    };
    for (const entry of entries) {
      if (entry.clip && run) {
        entry.nodes.forEach(node => { node.blendMode = 'source-atop'; });
        run.nodes.push(...entry.nodes);
        run.clipped = true;
        continue;
      }
      close();
      run = { nodes: [...entry.nodes], clipped: false };
    }
    close();
    return out;
  }
  // 무한 배경 둘레 그림(그림 칸을 잘라 낸 사본, 잠김)과 칸 테두리. 둘레는 그림 층 아래라 둘레에 그리는 획이 위로 보인다.
  function drawWrapExtras(ep, parts, tile) {
    areaState.copies?.remove(); areaState.frame?.remove(); areaState.backdrop?.remove(); areaState.twins?.remove();
    areaState.copies = areaState.frame = areaState.backdrop = areaState.twins = null;
    if (!wrapOn(ep)) return;
    const paper = ep.paper;
    if (!bitmapWrap(ep)) { // 벡터: 배경 레이어는 칸이라 둘레 바둑판은 그 아래 따로(잠김)
      const backdrop = new paper.Group({ insert: false, children: backgroundItems(paper, areaDisplay(ep, tile)) });
      backdrop.locked = true;
      backdrop.data.evrWrapBackdrop = true;
      parts.root.insertChild(parts.root.children.indexOf(parts.bg), backdrop);
      areaState.backdrop = backdrop;
    }
    const items = parts.paint.children.filter(item => item.data?.entryVectorCanvasBox !== '1');
    // 벡터: 칸 끝을 넘은 도형은 칸 크기만큼 옮긴 사본(쌍둥이)이 반대쪽에서 들어와 보이고, 사본은 그 도형 자리 순서에 있어야 한다
    // (아래 도형 위, 나중에 그린 위 도형 아래 — 사본을 그림 층 위에 한 묶음으로 두면 나중 도형을 가렸다: 시험으로 재현). 사본은 그림
    // 층 밖에 두어야 하므로(저장 SVG·되돌리기 기록·엔트리 도구에 안 들어가게) 그림 층 사이에 끼울 수 없다. 그래서 사본이 보이는 칸에서만
    // 바탕과 도형들을 차례로(도형마다 그 사본을 바로 위에) 다시 그린 덮개를 그림 층 위에 둔다. 덮개는 잠겨 엔트리 도구가 누르지 못하고
    // (paper hitTest는 잠긴 항목을 건너뜀), 그림이 바뀔 때마다(SNAPSHOT_SAVED) 다시 그린다 — 도형을 끄는 동안 그 칸은 옛 모습이다.
    const clean = item => { for (const node of [item, ...item.getItems({})]) { delete node.data.selected; delete node.data.guideItem; } return item; };
    const stacked = []; // 차례대로 { item, twins, clip }
    if (!bitmapWrap(ep)) {
      const regions = [];
      let clipBase = false;
      for (const item of items) {
        const flagged = !!item.data?.evrClip, clip = flagged && clipBase;
        if (!flagged) clipBase = true;
        const twins = [];
        if (hasArea(item.bounds)) for (const [dx, dy] of wrapOffsets(ep, tile)) {
          const moved = shiftRect(item.bounds, dx, dy);
          if (!moved.intersects(tile)) continue;
          const twin = clean(item.clone({ insert: false }));
          twin.translate(new paper.Point(dx, dy));
          twin.data.evrWrapTwin = true;
          twins.push(twin);
          regions.push(moved.intersect(tile));
        }
        stacked.push({ item, twins, clip });
      }
      if (regions.length) {
        const cover = regions.reduce((all, rect) => all.unite(rect));
        const mask = new paper.CompoundPath({ insert: false,
          children: regions.map(rect => new paper.Path.Rectangle({ rectangle: rect, insert: false })) });
        const children = [mask, ...backgroundItems(paper, tile),
          ...clipRunGroups(paper, stacked.map(({ item, twins, clip }) =>
            ({ clip, nodes: [...(item.bounds.intersects(cover) ? [clean(item.clone({ insert: false }))] : []), ...twins] })))];
        // clipped는 자식을 넣은 뒤에 건다(만들 때 같이 주면 paper가 첫 자식을 틀로 정하지 못해 덮개가 칸 전체를 덮었다 — 시험으로 찾음)
        const group = new paper.Group({ insert: false, children });
        group.clipped = true;
        group.locked = true;
        group.data.evrWrapTwins = true;
        parts.clip.insertChild(parts.clip.children.indexOf(parts.paint) + 1, group);
        areaState.twins = group;
      }
    }
    if (items.length) {
      // 둘레 그림도 같은 차례(도형마다 그 사본을 바로 위에)
      const order = bitmapWrap(ep) ? items.map(item => item.clone({ insert: false })) :
        clipRunGroups(paper, stacked.map(({ item, twins, clip }) =>
          ({ clip, nodes: [clean(item.clone({ insert: false })), ...twins.map(twin => twin.clone({ insert: false }))] })));
      const content = new paper.Group({ insert: false, clipped: true,
        children: [new paper.Path.Rectangle({ rectangle: tile, insert: false }), ...order] });
      const definition = new paper.SymbolDefinition(content);
      const copies = new paper.Group({ insert: false });
      for (const [dx, dy] of wrapOffsets(ep, tile))
        copies.addChild(new paper.SymbolItem({ definition, position: tile.center.add([dx, dy]), insert: false }));
      copies.locked = true;
      copies.data.evrWrapCopies = true;
      parts.root.insertChild(parts.root.children.indexOf(parts.clip), copies);
      areaState.copies = copies;
    }
    const frame = new paper.Path.Rectangle({ rectangle: tile, insert: false, strokeColor: '#4f80ff', strokeWidth: 1,
      dashArray: [6, 4], strokeScaling: false, fillColor: null });
    frame.locked = true;
    frame.data.evrWrapFrame = true;
    parts.root.insertChild(parts.root.children.indexOf(parts.clip) + 1, frame);
    areaState.frame = frame;
  }
  const paintSignature = parts => parts.paint.children.map(item =>
    `${item.id}:${Math.round(item.bounds.x)},${Math.round(item.bounds.y)},${Math.round(item.bounds.width)},${Math.round(item.bounds.height)}`).join('|');
  // 그림이 다 들어가는 작업 영역 크기(가운데 home 기준 대칭, 짝수). 그림이 없으면 null.
  function contentSize(ep) {
    const parts = stageParts(ep);
    if (!parts) return null;
    const home = areaHome(ep);
    let halfW = 0, halfH = 0;
    for (const item of parts.paint.children) {
      if (item.data?.entryVectorCanvasBox === '1') continue;
      const b = item.bounds;
      if (!(b.width > 0 || b.height > 0)) continue;
      halfW = Math.max(halfW, home.x - b.left, b.right - home.x);
      halfH = Math.max(halfH, home.y - b.top, b.bottom - home.y);
    }
    return halfW || halfH ? { w: Math.ceil(halfW) * 2, h: Math.ceil(halfH) * 2 } : null;
  }
  // 그림이 칸보다 크면(큰 그림을 열었거나, 확장 없이 무대 밖에 그린 벡터) 그만큼 넓힌다. 줄이지는 않는다.
  // 한도를 넘는 그림은 한도까지만 넓어지므로, 고치면 잘린다고 알린다.
  // 벡터 무한 배경 방향으로는 넓히지 않는다: 칸 끝을 넘은 도형은 반대쪽으로 이어 보이는 것이라(넓히면 이음이 사라짐 — 시험으로 찾음).
  function fitArea(ep) {
    const need = contentSize(ep);
    if (!need) return;
    const [ax, ay] = ep.mode === 'VECTOR' ? wrapAxes(ep) : [0, 0];
    const w = Math.max(areaState.size?.w || AREA_DEFAULT.w, ax ? 0 : need.w), h = Math.max(areaState.size?.h || AREA_DEFAULT.h, ay ? 0 : need.h);
    if (w > (areaState.size?.w || AREA_DEFAULT.w) || h > (areaState.size?.h || AREA_DEFAULT.h)) setArea(ep, w, h, areaState.wrap);
    if (!areaFits(w, h) && ep.mode === 'BITMAP')
      toast(`그림이 너무 커서(${need.w}×${need.h}) 캔버스를 다 넓히지 못했습니다(한 변 ${AREA_MAX}px, 전체 4096×4096px까지). ` +
        '이 비트맵을 고치면 칸 밖이 잘립니다.', 8000);
  }
  // 그림 층에 그림(Raster)이 들어오는 자리(addChild)에서 두 가지를 한다.
  // 1) 비트맵 무한 배경: 무대 사각형을 둘레까지(칸 3배) 두어 엔트리가 둘레에 그린 것을 자르지 않게 하고(applyStageRect), 엔트리가
  //    구운 그림이 들어오는 순간(획·도형 끝, 선택 합치기 Lr→jr, 빈 그림 만들기) 칸 크기로 접는다(collapsedTile). 엔트리는 이어서
  //    되돌리기 기록(saveSnapshot)을 남기므로 기록에도 접힌 그림이 남는다. 예전처럼 굽기 직전에 사본을 넣는 방식은 선택 합치기가
  //    굽기 전에 무대 밖을 먼저 잘라(Lr) 칸 밖으로 옮긴 조각이 반대쪽으로 가지 않고 사라졌다(검토로 찾음).
  // 2) 비트맵 뼈대 이어 주기: 엔트리는 획을 마칠 때마다 그림을 새 Raster로 구워 바꿔 넣어(rasterize → 무대 밖 자르기 →
  //    removeChildren·addChild) 그림 데이터(뼈대·휘기 전 그림)가 사라진다. 구울 때 들고 있다가 같은 동작 안에서(같은 실행 순간)
  //    들어오는 새 그림에 넣는다. 다음 마이크로태스크에 버려, 저장할 때 PNG를 구운 뒤 늦게 들어오는 다른 모양 그림에는 붙지 않는다.
  //    그림이 실제로 바뀌었으면 다음에 뼈대를 열 때 화소 요약이 달라 지금 그림이 새 기준이 된다(reconcileBitmapRig).
  // 확장이 그림을 읽으려고 부르는 rasterize — 엔트리 획 굽기가 아니므로 뼈대를 옮겨 싣지 않는다(바로 뒤에 넣는 다른 레이어 그림에 붙지 않게)
  let ownRasterizing = 0;
  function ownRasterize(item, options) {
    ownRasterizing++;
    try { return item.rasterize(options); } finally { ownRasterizing--; }
  }
  function hookPaintLayer(ep, parts) {
    const layer = parts.paint;
    if (own(layer, '__evrPaintHook')) return;
    Object.defineProperty(layer, '__evrPaintHook', { value: true });
    const original = layer.rasterize, add = layer.addChild;
    let carry = null;
    layer.addChild = function (item, ...rest) {
      if (isRasterLayer(item)) {
        try {
          // 모양을 바꾸면 엔트리는 file.id를 먼저 바꾸고 그림을 넣는다. 작업 영역은 0.5초 갱신·SNAPSHOT_SAVED에서야 새 모양 것으로 바뀌어,
          // 무한 배경 모양에서 큰 모양으로 바꾸면 들어오는 그림이 앞 모양 칸으로 접혀 들어갔다(재현 2026-10-16: 1920 그림이 960 칸에
          // 겹쳐 열림, 3번 중 3번). 넣기 전에 지금 모양 작업 영역으로 맞춘다.
          const painter = window.Entry?.playground?.painter;
          if (areaState.ep === ep && painter?.entryPaint === ep && (painter.file?.id ?? null) !== areaState.fileId) syncAreaFile(painter, ep);
          const tile = ep.mode === 'BITMAP' && wrapOn(ep) && areaTile(ep);
          if (tile && item.width && item.height && plainRaster(item) && !tile.contains(item.bounds)) {
            const b = item.bounds;
            // 엔트리 비트맵 그림은 엔트리의 '불러오면 화면 가운데로·기록 비우기' 처리를 달고 있어 setImage가 그것을 다시 부른다(탐침으로 확인) — 떼고 바꾼다
            replaceRasterImage(item, collapsedTile(ep, tile, item.canvas || item.image, b.x, b.y));
            item.position = tile.center;
          }
        } catch (error) { console.warn('[entry-vector-rig] 무한 배경 잇기', error); }
        if (carry && !item.data?.[BONES]) { Object.assign(item.data, carry); carry = null; }
      }
      return add.call(this, item, ...rest);
    };
    layer.rasterize = function (...args) {
      const held = !ownRasterizing && this.children.find(item => isRasterLayer(item) && item.data?.[BONES]);
      if (held) {
        carry = { [BONES]: held.data[BONES] };
        if (held.data[BITMAP_REST]) carry[BITMAP_REST] = held.data[BITMAP_REST];
        queueMicrotask(() => { carry = null; });
      }
      return original.apply(this, args);
    };
  }
  // 비트맵 지우개는 경로 없이 그림 픽셀을 바로 지운다(eraseRaster 선분 · eraseSmallDot 작은 점). 칸 밖을 지운 만큼 반대쪽도 지운다.
  function hookWrapEraser(ep) {
    const tool = ep.paper.tools?.find(item => item.MY_MODE?.toolMode === 'ERASER' && item.MY_MODE?.graphicsMode === 'BITMAP');
    if (!tool || own(tool, '__evrWrapEraser') || typeof tool.eraseRaster !== 'function') return;
    Object.defineProperty(tool, '__evrWrapEraser', { value: true });
    const line = tool.eraseRaster, dot = tool.eraseSmallDot;
    const shifted = (reach, run) => {
      const tile = wrapOn(ep) && areaTile(ep);
      if (!tile) return;
      for (const [dx, dy] of wrapOffsets(ep, tile)) if (shiftRect(reach, dx, dy).intersects(tile)) run(dx, dy);
    };
    tool.eraseRaster = function (a, b, ...rest) {
      line.call(this, a, b, ...rest);
      const pad = (this.eraserSize || 1) / 2 + 1;
      shifted(new ep.paper.Rectangle(a, b).expand(pad * 2), (dx, dy) => line.call(this, a.add([dx, dy]), b.add([dx, dy]), ...rest));
    };
    if (typeof dot === 'function') tool.eraseSmallDot = function (point, size, ...rest) {
      dot.call(this, point, size, ...rest);
      shifted(new ep.paper.Rectangle(point.subtract([size, size]), point.add([size, size])),
        (dx, dy) => dot.call(this, point.add([dx, dy]), size, ...rest));
    };
  }
  // 칸 밖(둘레 사본 위)을 누른 점을 그림 칸 안 같은 자리로(채우기 등)
  function wrapPoint(ep, point) {
    const tile = wrapOn(ep) && areaTile(ep);
    if (!tile) return point;
    const [ax, ay] = wrapAxes(ep), mod = (value, start, size) => start + ((value - start) % size + size) % size;
    return new ep.paper.Point(ax ? mod(point.x, tile.x, tile.width) : point.x, ay ? mod(point.y, tile.y, tile.height) : point.y);
  }
  // 도구 이벤트의 점만 그림 칸 안으로 옮긴 사본(나머지는 원래 이벤트를 그대로 읽음). 무한 배경이 아니면 그대로.
  function wrapToolEvent(ep, event) {
    if (!event?.point || !wrapOn(ep)) return event;
    const point = wrapPoint(ep, event.point);
    return point.equals(event.point) ? event : Object.create(event, { point: { value: point } });
  }
  // 칸 밖으로 넘어간 그림을 칸 크기만큼 옮긴 자리(반대쪽)에 접어 넣은 칸 크기 캔버스(Aseprite collapseRegionByTiledMode).
  // source는 그림 좌표 (x, y)에 놓인 그림. 칸 안 부분은 그대로, 둘레(칸 3배 범위)는 반대쪽으로.
  function collapsedTile(ep, tile, source, x, y) {
    const canvas = canvasOfSize(tile.width, tile.height), ctx = canvas.getContext('2d');
    for (const [dx, dy] of [[0, 0], ...wrapOffsets(ep, tile)])
      ctx.drawImage(source, Math.round(x - tile.x - dx), Math.round(y - tile.y - dy));
    return canvas;
  }
  // 무한 배경 벡터 저장 그림: 칸 그대로, 도형마다 차례로 그 도형과 칸 크기만큼 옮긴 자리를 그린다(화면 덮개와 같은 차례 — 넘어간
  // 부분이 그 위 도형을 덮지 않음). 그림 층을 통째로 구워 접으면(collapsedTile) 넘어간 부분이 모든 도형 위에 왔다(시험으로 재현).
  function vectorWrapTileCanvas(ep) {
    const parts = stageParts(ep), tile = areaTile(ep);
    if (!parts || !tile) return null;
    const canvas = canvasOfSize(tile.width, tile.height), context = canvas.getContext('2d');
    for (const item of parts.paint.children) {
      if (item.data?.entryVectorCanvasBox === '1') continue;
      const raster = item.rasterize({ resolution: 72, insert: false });
      if (!raster.width || !raster.height) continue;
      const b = raster.bounds;
      for (const [dx, dy] of [[0, 0], ...wrapOffsets(ep, tile)])
        context.drawImage(raster.canvas, Math.round(b.x - tile.x - dx), Math.round(b.y - tile.y - dy));
    }
    return canvas;
  }
  // 무한 배경 비트맵 저장 그림: 그림 칸 그대로(투명한 가장자리도 남겨 칸 크기가 바뀌지 않게).
  function wrapTileCanvas(ep) {
    const parts = stageParts(ep), tile = areaTile(ep);
    if (!parts || !tile) return null;
    const raster = ownRasterize(parts.paint, { resolution: 72, insert: false });
    if (!(raster.width && raster.height)) return canvasOfSize(tile.width, tile.height);
    return collapsedTile(ep, tile, raster.canvas, raster.bounds.x, raster.bounds.y);
  }
  function ensureCanvasArea(painter) {
    const ep = painter?.entryPaint;
    if (!ep?.project) return;
    const parts = stageParts(ep);
    if (!parts) return;
    if (areaState.ep !== ep) {
      // 처음 볼 때 무대 틀은 아직 엔트리 무대 크기다(확장이 바꾸기 전) — 그 가운데가 home
      const c0 = parts.mask.bounds.center;
      Object.assign(areaState, { ep, bg: parts.bg, stageRect: null, size: null, wrap: 'none', fileId: undefined,
        copies: null, frame: null, backdrop: null, twins: null, signature: '', home: { x: c0.x, y: c0.y }, mode: ep.mode });
      hookStageRect(ep.paper);
      hookMoveClamp(ep);
      try { ep.getDataURL(); } catch { /* 무대 사각형 붙잡기용. 실패해도 다음 자르기 때 붙잡는다 */ }
      hookPaintLayer(ep, parts);
      // 그림을 넣을 때(모양 열기·모양 가져오기로 지금 모양에 넣기 모두 addSVG·addBitmap) 들어온 그림 크기에 맞춘다.
      for (const name of ['addSVG', 'addBitmap']) {
        const original = ep[name];
        if (typeof original !== 'function' || own(ep, name)) continue;
        ep[name] = function (...args) { areaState.pendingFit = true; return original.apply(this, args); };
      }
      // 그림이 들어오거나 고칠 때마다(엔트리 SNAPSHOT_SAVED) 칸보다 큰 그림이면 넓히고 둘레 그림을 다시 그린다.
      // 엔트리는 그림을 불러올 때는 자르지 않고 처음 고칠 때 무대 밖을 자르므로, 불러온 직후 넓히면 잘리지 않는다.
      // 그리는 중(획마다)에는 넓히지 않는다: 무대 끝을 살짝 넘은 벡터 획 때문에 캔버스가 갑자기 커지지 않게.
      ep.on?.('SNAPSHOT_SAVED', () => {
        if (areaState.ep !== ep) return;
        try {
          syncAreaFile(painter, ep);
          if (areaState.pendingFit) {
            // 모양을 연 뒤 첫 그림: 그 모양 크기로 다시 정한다(앞서 이전 모양 그림으로 넓혔을 수 있어 줄이기도 함)
            areaState.pendingFit = false;
            const choice = areaChoices.get(areaState.fileId);
            setArea(ep, choice?.w ?? AREA_DEFAULT.w, choice?.h ?? AREA_DEFAULT.h, choice?.wrap ?? 'none');
            fitArea(ep);
          }
          // 둘레 사본은 그림이 바뀔 때마다 다시 그린다(색만 바꾸거나 같은 그림 화소를 고쳐도 — 지우개는 그 자리에서 고침)
          const tile = wrapOn(ep) && areaTile(ep), now = tile && stageParts(ep);
          if (now) { drawWrapExtras(ep, now, tile); areaState.signature = paintSignature(now); }
        } catch (error) { console.warn('[entry-vector-rig] 캔버스 크기', error); }
      });
    }
    hookWrapEraser(ep);
    hookShapeDrag(ep);
    syncAreaFile(painter, ep);
    // 비트맵·벡터를 바꾸면 무대 사각형·배경·잘라 보이는 틀 범위가 달라진다(비트맵 무한 배경만 둘레까지)
    if (areaState.mode !== ep.mode && (areaState.size || wrapOn(ep)))
      setArea(ep, areaState.size?.w ?? AREA_DEFAULT.w, areaState.size?.h ?? AREA_DEFAULT.h, areaState.wrap);
    areaState.mode = ep.mode;
    if (wrapOn(ep)) {
      const signature = paintSignature(parts);
      if (signature !== areaState.signature) {
        areaState.signature = signature;
        const tile = areaTile(ep);
        if (tile) drawWrapExtras(ep, parts, tile);
      }
    }
  }
  // 모양을 바꾸면 그 모양의 작업 영역(이 탭에서 고른 값, 없으면 기본)으로 돌리고, 그 모양 그림이 들어온 첫 SNAPSHOT_SAVED에서
  // 그림 크기에 맞춘다(엔트리는 file.id를 먼저 바꾸고 그림은 나중에 넣으므로, 바로 재면 이전 모양 그림 크기가 된다).
  function syncAreaFile(painter, ep) {
    const id = painter.file?.id ?? null;
    if (id === areaState.fileId) return;
    areaState.fileId = id;
    areaState.pendingFit = true;
    const choice = areaChoices.get(id);
    setArea(ep, choice?.w ?? AREA_DEFAULT.w, choice?.h ?? AREA_DEFAULT.h, choice?.wrap ?? 'none');
    // 이미 들어와 있는 그림(확장이 늦게 붙었거나 그림이 먼저 들어온 경우)도 첫 획에 잘리지 않게 바로 맞춘다.
    // 아직 이전 모양 그림이면 다음 SNAPSHOT_SAVED에서 다시 정한다.
    fitArea(ep);
  }
  // [도구] → 캔버스: 너비·높이(기준점 3×3: 기존 그림이 붙어 있을 자리, 포토샵·GIMP 캔버스 크기와 같은 뜻)와 무한 배경
  let canvasDialog = null;
  function openCanvasDialog(c) {
    if (canvasDialog) return canvasDialog;
    const ep = c.ep, painter = c.p;
    ensureCanvasArea(painter);
    const now = { w: areaState.size?.w || AREA_DEFAULT.w, h: areaState.size?.h || AREA_DEFAULT.h };
    let anchor = { x: .5, y: .5 };
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    const backdrop = node('div', 'evr-slicer-backdrop'), dialog = node('section', 'evr-slicer evr-canvas');
    dialog.setAttribute('aria-label', '캔버스');
    const header = node('header', 'evr-slicer-head'), closeButton = node('button', 'evr-slicer-x', '×');
    closeButton.type = 'button'; closeButton.title = '닫기';
    header.append(node('h2', '', `캔버스 · ${c.picture.name}`), closeButton);
    const side = node('div', 'evr-slicer-side evr-canvas-side');
    const section = title => { const box = node('div', 'evr-slicer-section'); box.append(node('h3', '', title)); side.append(box); return box; };
    const field = (label, input) => { const row = node('label', 'evr-slicer-field'); row.append(node('span', '', label), input); return row; };
    const number = value => { const input = node('input'); Object.assign(input, { type: 'number', min: String(AREA_MIN), max: String(AREA_MAX), step: '2', value: String(value) }); return input; };
    const wInput = number(now.w), hInput = number(now.h);
    const presets = node('div', 'evr-slicer-row');
    for (const [label, w, h] of [['기본 960×540', 960, 540], ['가로 2배', 1920, 540], ['가로 3배', 2880, 540],
      ['세로 2배', 960, 1080], ['2배', 1920, 1080]]) {
      const preset = node('button', '', label); preset.type = 'button';
      preset.addEventListener('click', () => { wInput.value = String(w); hInput.value = String(h); update(); });
      presets.append(preset);
    }
    section('크기 (px)').append(field('너비', wInput), field('높이', hInput), presets);
    const pivotGrid = node('div', 'evr-slicer-pivot');
    for (const [label, x, y] of PIVOTS) {
      const choice = node('button'); choice.type = 'button'; choice.title = label;
      choice.setAttribute('aria-label', label);
      choice.setAttribute('aria-pressed', String(x === anchor.x && y === anchor.y));
      choice.addEventListener('click', () => {
        anchor = { x, y };
        pivotGrid.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === choice)));
      });
      pivotGrid.append(choice);
    }
    section('기준').append(pivotGrid, node('p', 'evr-slicer-note', '지금 그림이 붙어 있을 자리입니다. 가운데면 사방으로 똑같이 늘거나 줄어듭니다.'));
    const wrapSelect = node('select');
    for (const [value, label] of Object.entries(WRAP_LABELS)) {
      const option = node('option', '', label); option.value = value; wrapSelect.append(option);
    }
    wrapSelect.value = areaState.wrap;
    section('무한 배경').append(field('이어 붙이기', wrapSelect), node('p', 'evr-slicer-note',
      '그림 칸 둘레에 같은 그림을 이어 보여 줍니다. 비트맵은 칸 밖으로 넘어간 붓·도형·지우개가 반대쪽에 그려지고, ' +
      '칸 크기 그대로 저장됩니다. 벡터는 도형을 그대로 두고 칸 끝을 넘은 부분을 반대쪽에 이어 보여 주며, 실행 화면 그림은 칸 크기 그대로 이어서 저장됩니다.'));
    side.append(node('p', 'evr-slicer-note', '확장이 꺼진 엔트리에서도 큰 모양은 그대로 보이지만, 그림판에서 비트맵을 고치면 ' +
      '960×540 밖이 잘립니다. 크기는 이 창을 닫아도 이 모양에 남고, 새로 고치면 그림 크기에 맞춰 다시 정해집니다.'));
    const footer = node('footer', 'evr-slicer-foot'), status = node('span', 'evr-slicer-status', '');
    const cancel = node('button', 'evr-slicer-cancel', '닫기'); cancel.type = 'button';
    const apply = node('button', 'evr-slicer-create', '적용'); apply.type = 'button';
    footer.append(status, cancel, apply);
    const body = node('div', 'evr-slicer-body'); body.append(side);
    dialog.append(header, body, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);
    const read = () => ({ w: Number(wInput.value), h: Number(hInput.value) });
    const content = contentSize(ep); // 지금 그림이 다 들어가는 크기(기준이 가운데일 때)
    function update() {
      const { w: rawW, h: rawH } = read(), w = Math.round(rawW / 2) * 2, h = Math.round(rawH / 2) * 2;
      const ok = [w, h].every(Number.isFinite) && areaFits(w, h);
      apply.disabled = !ok;
      // 그림보다 작게 줄이면 비트맵은 다음에 고칠 때 밖이 잘린다(줄이는 것은 막지 않고 알린다). 기준을 옮기면 그림도 옮겨지므로
      // 가운데 기준일 때만 정확하다.
      const small = ok && content && (w < content.w || h < content.h);
      status.textContent = !ok ? `크기는 한 변 ${AREA_MIN}~${AREA_MAX}px, 전체 4096×4096px까지 넣으세요.` :
        `지금 ${now.w}×${now.h} → ${w}×${h}` + (small ? ` · 그림(${content.w}×${content.h})보다 작아 비트맵은 고칠 때 밖이 잘립니다` : '');
      status.dataset.warn = String(!!small);
    }
    wInput.addEventListener('input', update);
    hInput.addEventListener('input', update);
    function run() {
      update();
      if (apply.disabled) return;
      const { w: rawW, h: rawH } = read(), w = Math.round(rawW / 2) * 2, h = Math.round(rawH / 2) * 2;
      // 기준점 쪽 가장자리가 그대로 남도록 그림을 옮긴다(작업 영역 가운데는 home 그대로). 되돌리기 한 단계.
      const dx = Math.round((anchor.x - .5) * (w - now.w)), dy = Math.round((anchor.y - .5) * (h - now.h));
      // 고른 값을 먼저 기억한다(되돌리기 기록의 SNAPSHOT_SAVED에서 작업 영역을 다시 정할 때 이 값을 쓰게).
      areaChoices.set(painter.file?.id ?? null, { w, h, wrap: wrapSelect.value });
      setArea(ep, w, h, wrapSelect.value);
      if (dx || dy) {
        const items = c.layer.children.filter(item => item.data?.entryVectorCanvasBox !== '1');
        items.forEach(item => item.translate(dx, dy));
        if (items.length) saveEntryHistory(ep);
      }
      close();
      toast(`캔버스 ${w}×${h}${wrapSelect.value !== 'none' ? ` · 무한 배경 ${WRAP_LABELS[wrapSelect.value]}` : ''}`, 3000);
    }
    apply.addEventListener('click', run);
    function onKey(event) {
      if (!(event.target instanceof Node) || (!dialog.contains(event.target) && event.target !== document.body)) return;
      if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.type === 'keydown' && event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); run(); }
      event.stopPropagation();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    function close() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      backdrop.remove();
      canvasDialog = null;
    }
    closeButton.addEventListener('click', close);
    cancel.addEventListener('click', close);
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); });
    canvasDialog = { close };
    update();
    wInput.focus({ preventScroll: true });
    wInput.select();
    return canvasDialog;
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
  // ---- 벡터 붓(엔트리 옵션 이름 "펜") 부드럽게 ----
  // 엔트리 벡터 붓(entry-paint 260921)은 끄는 동안 찍힌 점 사이를 직선 막대+원으로 이어 붙여 합친다. 새 점은 앞 점에서
  // 3+굵기/5만큼 떨어져야 찍히는데 이 거리가 그림 좌표라 확대할수록 화면에서 듬성해지고(1600%면 16배), 끌기 처리가
  // throttle로 묶여 빠른 획은 점이 더 빠진다. 그래서 곡선이 꺾은선이 된다.
  // 켜 두면 "점 넣기"만 바꾼다(비트맵 붓과 같은 방식): 브라우저가 주는 촘촘한 입력(PointerEvent.getCoalescedEvents)을
  // 화면 좌표에서 1€ 필터(Casiez·Roussel·Vogel, CHI 2012, 저자 구현 1eurofilter)로 손떨림만 거르고, 엔트리 자기 획 만들기
  // (brushItemMaker $r — 시작 원 + 점마다 둥근 막대를 이어 합침, 굵기가 늘 정확)에 엔트리 간격과 화면 4px 중 작은 간격으로
  // 넣는다. 획 모양·같은 색 붓 획 합치기·지우개로 빼기·되돌리기 기록은 모두 엔트리 코드 그대로다.
  // 예전엔 엔트리 획 만들기를 버리고 perfect-freehand 바깥선 → union → 곡선 맞춤으로 모양을 새로 만들었는데, 굵기가 변하는 선용
  // 라이브러리를 굵기가 일정한 붓에 써서 단계마다 따로 망가졌다(곧은 획 방추꼴, 점 하나면 굵기 3배 덩어리, 곡선 맞춤 오차 단위로
  // 확대 시 깎임 — 2026-10-14 사용자 영상·실측). 그래서 모양은 엔트리에 맡긴다.
  // 설정은 붓·지우개가 같이 쓰고 이 탭에서만 기억한다(새로 고치면 처음 값).
  const smoothBrush = { on: true, level: 1 };
  // 손떨림 보정 단계(0=끔)별 1€ 최소 차단 주파수(Hz, 낮을수록 많이 거름)와 빠르게 그릴 때 지연을 줄이는 beta(화면 px 기준).
  // 저자 절차(먼저 beta=0에서 느린 떨림이 사라질 mincutoff, 그다음 빠를 때 지연이 줄게 beta)대로 모의 시험으로 골랐다:
  // 120Hz 입력·반지름 150px 원·굵기 10에서 1단계는 느린 떨림(σ0.5px) 4.6→0.8px, 빠른 획(1200px/s) 안쪽 밀림 1.2px.
  // 단계가 클수록 떨림은 더 거르지만 빠른 획이 더 안쪽으로 밀린다(4단계 6px). 떨림 모형은 흰 잡음이라 실제 손과는 다를 수 있다.
  const BRUSH_MIN_CUTOFF = [0, 12, 8, 4, 2, 1];
  const BRUSH_BETA = 0.001;
  const BRUSH_MIN_STEP_PX = 0.5; // 이보다 가까운 입력 점은 버린다(화면 px)
  // 거르기 전 입력 점 간격 하한 = 붓 지름의 10%(래스터 붓의 "간격 = 지름의 %"와 같은 손잡이) — 크게 확대해 굵은 붓이 화면을 덮을 때
  // 작은 떨림까지 다 받지 않게
  const BRUSH_SPACING = 0.1;
  // 엔트리 획 만들기에 넣는 간격(화면 px) 상한. 엔트리 간격(벡터 3+굵기/5, 비트맵 4 — 그림 좌표)이 이보다 크면(확대할수록) 이 간격으로
  // 넣는다. 엔트리 막대 합치기는 촘촘할수록 무겁다(굵기 10·300px 직선, 실측: 1단위 간격 531ms·한 번에 97ms 멈춤, 4단위 48ms·5ms,
  // 엔트리 5단위 42ms·7ms) — 화면 4px이면 꺾은선이 안 보이면서(반지름 16px 곡선에서 어긋남 0.1px) 엔트리 원래와 비슷한 무게.
  const SMOOTH_SEGMENT_PX = 4;
  const smoothSegment = (entrySpacing, zoom, floor = 0) => Math.min(entrySpacing, Math.max(floor, SMOOTH_SEGMENT_PX / (zoom || 1)));
  // paper는 마우스 이벤트로 받는 경우가 있어 포인터 번호가 안 보인다. 같은 누르기의 포인터 이벤트를 따로 기억해 둔다.
  let lastPointerDown = null;
  document.addEventListener('pointerdown', event => { lastPointerDown = event; }, true);
  function vectorTool(ep, mode) {
    return ep?.paper?.tools?.find(tool => tool.MY_MODE?.toolMode === mode &&
      tool.MY_MODE?.graphicsMode === 'VECTOR') || null;
  }
  const SMOOTH_TOOLS = { BRUSH: '부드러운 붓', ERASER: '부드러운 지우개' };
  // 획 입력: 브라우저가 주는 촘촘한 입력(getCoalescedEvents)을 화면 좌표에서 1€ 필터로 거르고 점 간격 하한을 지켜
  // 그림 좌표 점으로 넘긴다(accept). 벡터·비트맵 붓·지우개가 같이 쓴다(SmoothFeed).
  class StrokeInput {
    constructor(ep, event, width) {
      this.paper = ep.paper;
      this.view = ep.project.view;
      this.width = width;
      this.last = null; // 마지막으로 받은 점(화면 px, 거른 값)
      this.lastRaw = null; // 마지막 실제 입력(그림 좌표) — 끝점 보정용
      this.native = false;
      this.frame = 0;
      const level = smoothBrush.level;
      this.filters = level > 0 ? [0, 1].map(() =>
        new window.oneEuroFilter.OneEuroFilter(120, BRUSH_MIN_CUTOFF[level], BRUSH_BETA)) : null;
      const down = event.event?.pointerType ? event.event :
        lastPointerDown && Math.abs(lastPointerDown.timeStamp - (event.event?.timeStamp ?? -1e9)) < 100 ? lastPointerDown :
          event.event;
      this.down = down;
      this.pointerId = down?.pointerId;
      // 화면 → 그림 좌표 바꿈이 paper와 크게 어긋나면(캔버스 CSS 크기 조정 등) 누른 점 기준으로 맞춘다.
      // 1.5 화면 px 미만은 맞추지 않는다: 포인터 이벤트는 소수 좌표, paper가 받는 마우스 이벤트는 정수라 그만큼은 늘 다르다.
      const mine = down && this.toProject(down.clientX, down.clientY);
      this.offset = mine ? event.point.subtract(mine) : null;
      if (this.offset && this.offset.length * this.view.zoom < 1.5) this.offset = null;
    }
    listen() {
      this.onMove = e => this.capture(e);
      this.onUp = e => { if (this.pointerId == null || e.pointerId === this.pointerId) this.stop(); };
      document.addEventListener('pointermove', this.onMove, true);
      document.addEventListener('pointerup', this.onUp, true);
      document.addEventListener('pointercancel', this.onUp, true);
    }
    toProject(clientX, clientY, rect = this.view.element.getBoundingClientRect()) {
      let point = this.view.viewToProject(new this.paper.Point(clientX - rect.left, clientY - rect.top));
      if (this.offset) point = point.add(this.offset);
      return point;
    }
    // 입력 하나를 걸러 새 점(그림 좌표)이면 돌려준다. 점 간격 하한보다 가까우면 null.
    accept(e, rect = this.view.element.getBoundingClientRect()) {
      let x = e.clientX - rect.left, y = e.clientY - rect.top;
      this.lastRaw = this.toProject(e.clientX, e.clientY, rect);
      // 실제 입력이 처음 누른 곳에서 얼마나 움직였나(화면 px) — 2px 미만이면 점 찍기로 본다
      this.rawStart ||= [e.clientX, e.clientY];
      this.rawMove = Math.max(this.rawMove || 0, Math.hypot(e.clientX - this.rawStart[0], e.clientY - this.rawStart[1]));
      if (this.filters) {
        const t = e.timeStamp / 1000;
        x = this.filters[0].filter(x, t);
        y = this.filters[1].filter(y, t);
      }
      const minStep = Math.max(BRUSH_MIN_STEP_PX, this.width * this.view.zoom * BRUSH_SPACING);
      if (this.last && Math.hypot(x - this.last[0], y - this.last[1]) < minStep) return null;
      this.last = [x, y];
      const point = this.view.viewToProject(new this.paper.Point(x, y));
      return this.offset ? point.add(this.offset) : point;
    }
    add(e, fallback, rect) {
      if (!e || !Number.isFinite(e.clientX)) {
        if (fallback) this.take(fallback);
        return;
      }
      const point = this.accept(e, rect);
      if (point) this.take(point);
    }
    capture(e) {
      if (this.pointerId != null && e.pointerId !== this.pointerId) return;
      const samples = e.getCoalescedEvents?.(), rect = this.view.element.getBoundingClientRect();
      for (const sample of samples?.length ? samples : [e]) this.add(sample, null, rect);
      this.native = true;
      this.schedule();
    }
    // 엔트리 끌기(throttle)·놓기에서 부른다. 바로 입력을 받는 동안엔 엔트리 점은 쓰지 않는다.
    move(event) {
      if (!this.native) { this.add(event.event, event.point); this.schedule(); }
    }
    take() {}
    schedule() {}
    stop() {
      document.removeEventListener('pointermove', this.onMove, true);
      document.removeEventListener('pointerup', this.onUp, true);
      document.removeEventListener('pointercancel', this.onUp, true);
    }
  }
  // 끄는 동안 잠깐 있는 미리보기(레이어가 아님 — 레이어 목록·클리핑 기준에서 뺌). 항목 data가 아니라 여기에 둔다: 엔트리가 놓을 때
  // 남기는 되돌리기 기록에 표시가 들어가면 안 된다.
  const strokePreview = new WeakSet();
  // 벡터 부드러운 지우개 미리보기: 엔트리는 끄는 동안 흰 막대 조각을 맨 위 작업 층에 보여 주고 놓을 때 지운다. 그 조각은 가리고
  // (투명도 0 — 합쳐진 조각도 따라감, 놓으면 엔트리가 떼어 냄), 같은 중심선·굵기·둥근 끝과 꺾임(= 엔트리 조각을 합친 모양)의 선을
  // 그림 층 맨 위에 "뚫기"(destination-out)로 그려 끄는 동안 그 자리가 바로 지워져 보이게 한다. 그림 층은 불투명도를 1보다 아주 조금
  // 낮춰 따로 합성되게 해(paper가 층을 따로 그려 얹음) 뚫기가 아래 바둑판 배경까지 뚫지 않게 하고, 놓으면 되돌린다.
  class EraserPreview {
    constructor(ep, layer, entryLayer, known, start, width) {
      this.layer = layer;
      this.opacity = layer.opacity;
      layer.opacity = Math.min(layer.opacity, .99999);
      this.entryLayer = entryLayer;
      this.known = known;
      this.path = new ep.paper.Path({ segments: [start, start], strokeColor: '#000', strokeWidth: width, strokeCap: 'round',
        strokeJoin: 'round', blendMode: 'destination-out', insert: false });
      strokePreview.add(this.path);
      layer.addChild(this.path);
      // 글자는 엔트리 지우개가 지우지 않는다(도형이 아니라 일부만 뺄 수 없음). 끄는 동안에도 지워져 보이지 않게 뚫기 선 위에 글자를
      // 한 번 더 그린다(놓을 때 걷음) — 놓으면 되살아나는 것처럼 보이지 않게.
      this.keep = [];
      for (const text of layer.getItems({ class: ep.paper.PointText })) {
        if (!text.visible || strokePreview.has(text)) continue;
        let toLayer = text.matrix.clone();
        for (let parent = text.parent; parent && parent !== layer; parent = parent.parent) toLayer = parent.matrix.clone().append(toLayer);
        const copy = text.clone({ insert: false });
        copy.matrix = toLayer;
        strokePreview.add(copy);
        layer.addChild(copy);
        this.keep.push(copy);
      }
      this.hideEntry();
    }
    add(point) { this.path.add(point); this.hideEntry(); }
    hideEntry() {
      for (const child of this.entryLayer?.children || []) if (!this.known.has(child)) { this.known.add(child); child.opacity = 0; }
    }
    end() {
      if (!this.path) return;
      this.path.remove();
      this.path = null;
      for (const copy of this.keep) copy.remove();
      this.keep = [];
      this.layer.opacity = this.opacity;
    }
  }
  // 거른 점을 엔트리 그리기에 앞 점 → 새 점으로 차례로 넘긴다: 벡터 붓·지우개는 엔트리 획 만들기(brushItemMaker.move), 비트맵 붓·지우개는
  // 엔트리 그리기 함수(붓 drawRaster·지우개 eraseRaster). 번짐 없는 화소 만들기·사각 펜·투명 잠금·무한 배경·굽기·되돌리기는 엔트리와 확장의
  // 원래 길을 그대로 탄다(엔트리 drawRaster는 lodash throttle을 기다림 없이 써서 한 동작 안에서 여러 번 불러도 모두 그린다 — 시험으로 확인).
  // 잇는 간격 = 엔트리 간격과 화면 SMOOTH_SEGMENT_PX 중 작은 쪽(비트맵은 1화소 아래로는 안 내림) — 엔트리 간격은 그림 좌표라 크게 확대하면
  // 화면에서 듬성해져(1400%에서 비트맵 4화소 = 화면 56px) 보정을 켜도 꺾은선이었다.
  // 엔트리 drawRaster는 부를 때마다 두 점 사이 선을 72dpi로 구워 알파 경계로 끊은 그림 조각을 하나 만들고(한 번 약 2ms, 선분 길이와 거의
  // 무관 — 실측) 놓을 때까지 쌓는다. 예전엔 거른 점(간격 하한 = 지름 10%, 굵기 10이면 1px)과 합쳐 온 표본마다 불러, 같은 거리에 엔트리
  // 붓(도구 minDistance 4마다)보다 몇 배 많이 굽고 조각이 쌓여 획이 끊기고 길수록 느려졌다(사용자 제보 "랙·뚝뚝" — 몰아 보낸 입력 시험에서
  // 이벤트 47개에 56번). 이제 거른 점을 모았다가 화면 한 프레임에 한 번, 앞 점에서 엔트리 도구 자신의 간격(minDistance) 이상 떨어진
  // 점까지만 잇는다(엔트리 붓과 같은 촘촘함, 점은 거른 것이라 매끄러움). 모자란 끝 점은 다음 프레임이나 손을 뗄 때 잇는다.
  // 한 프레임에 잇는 수는 실제로 걸린 시간으로 정한다(프레임당 약 4ms 안): 빠르게 그으면 한 프레임에 간격 4짜리 점이 십여 개 생겨
  // 엔트리 붓(한 번 약 2ms)은 프레임마다 20ms 넘게 끊겼다(사용자 제보 — 사각 펜(한 번 0.1ms)은 괜찮음). 엔트리 원래 붓은 마우스 이동
  // 이벤트(대략 프레임당 한 번)마다 한 번 그린다. 넘치면 그 프레임의 점을 고르게 골라 잇는다(마지막 점은 늘 포함).
  const SMOOTH_FRAME_BUDGET_MS = 4, smoothDrawCost = new Map(); // 도구·사각 펜 여부 → 한 번 그리는 데 걸린 시간(이동 평균, ms)
  class SmoothFeed extends StrokeInput {
    constructor(ep, event, width, draw, segment, costKey) {
      super(ep, event, width);
      this.draw = draw;
      this.segment = segment > 0 ? segment : 4;
      this.costKey = costKey || 'brush';
      this.prev = event.point; // 시작 점은 엔트리 누르기가 이미 그렸다
      this.pending = []; // 아직 넘기지 않은 점(그림 좌표)
      this.listen();
      if (this.down && Number.isFinite(this.down.clientX)) this.accept(this.down);
    }
    take(point) { this.pending.push(point); }
    schedule() {
      if (this.frame || !this.pending.length) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.flush(false); });
    }
    // all: 간격이 모자란 마지막 점까지(손을 뗄 때)
    flush(all) {
      const points = this.pending;
      this.pending = [];
      const picks = [];
      let from = this.prev;
      points.forEach((point, index) => {
        const last = index === points.length - 1;
        if (point.getDistance(from) >= this.segment || (all && last && point.getDistance(from) * this.view.zoom >= BRUSH_MIN_STEP_PX)) {
          picks.push(point);
          from = point;
        } else if (last && !all) this.pending.push(point);
      });
      let chosen = picks;
      const cost = smoothDrawCost.get(this.costKey) ?? 2;
      const room = Math.max(1, Math.min(16, Math.floor(SMOOTH_FRAME_BUDGET_MS / Math.max(.05, cost))));
      if (!all && picks.length > room) {
        chosen = [];
        for (let k = 1; k <= room; k++) chosen.push(picks[Math.round(k * picks.length / room) - 1]);
      }
      for (const point of chosen) {
        const t0 = performance.now();
        this.draw(this.prev, point);
        smoothDrawCost.set(this.costKey, (smoothDrawCost.get(this.costKey) ?? cost) * .7 + (performance.now() - t0) * .3);
        this.prev = point;
      }
    }
    // 손을 떼면(포인터 놓기 — 엔트리 놓기보다 먼저) 남은 점까지 그린다
    stop() {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.flush(true);
      super.stop();
    }
    // 놓을 때 손을 뗀 실제 자리까지 잇는다(보정·간격 하한 때문에 끝이 덜 그려지지 않게) — 붓은 엔트리 놓기가 이 일을 한다
    finish(point) {
      this.stop();
      const end = point || this.lastRaw;
      if (end) { this.take(end); this.flush(true); }
    }
  }
  function wrapBitmapSmooth(ep, tool, mode) {
    tool.__evrSmooth = true;
    const down = tool.onMouseDown, drag = tool.onMouseDrag, up = tool.onMouseUp;
    tool.onMouseDown = function (event) {
      tool.__evrStroke?.stop();
      tool.__evrStroke = null;
      const result = down.call(this, event);
      if (!smoothBrush.on || !window.oneEuroFilter?.OneEuroFilter) return result;
      try {
        // 엔트리가 그리기를 시작했을 때만(붓 drawing·임시 묶음, 지우개 대상 그림) — 지금 엔트리 비트맵 붓·지우개 누르기는 늘 시작하지만
        // (entry-paint 260921: 벡터 도구와 달리 배경 범위 검사 없음), 바뀌어도 엔트리 기록 없이 그리지 않게
        const started = () => mode === 'ERASER' ? !!tool.targetRaster : !!(tool.drawing && tool.tempGroup);
        const width = mode === 'ERASER' ? tool.eraserSize : paintStore()?.getState().tool.userBrushWidth;
        const draw = mode === 'ERASER' ? (a, b) => { if (started()) tool.eraseRaster(a, b); } : (a, b) => { if (started()) tool.drawRaster(a, b, true); };
        // 잇는 간격 = 엔트리가 그 도구를 누를 때 거는 끌기 간격(붓 minDistance 4, 지우개 2)과 화면 4px 중 작은 쪽, 1화소 아래로는 안 내림
        const segment = smoothSegment(tool.minDistance || 4, ep.project.view.zoom, 1);
        if (width > 0 && started()) tool.__evrStroke = new SmoothFeed(ep, event, width, draw, segment, `${mode}:${pixelPen.square ? 'square' : 'entry'}`);
      } catch (error) {
        console.warn('[entry-vector-rig] 부드러운 붓(비트맵)', error);
        tool.__evrStroke = null;
      }
      return result;
    };
    tool.onMouseDrag = function (event) {
      const stroke = tool.__evrStroke;
      if (!stroke) return drag.call(this, event);
      if (mode === 'BRUSH' && !tool.drawing) return undefined;
      stroke.move(event);
      if (mode === 'ERASER' && tool.point) tool.point.position = event.point; // 지우개 커서 원(엔트리 끌기와 같게)
      return undefined;
    };
    tool.onMouseUp = function (event) {
      const stroke = tool.__evrStroke;
      tool.__evrStroke = null;
      try { if (mode === 'ERASER') stroke?.finish(event.point); else stroke?.stop(); }
      catch (error) { console.warn('[entry-vector-rig] 부드러운 붓(비트맵)', error); }
      return up.call(this, event);
    };
  }
  function ensureSmoothBrush(painter) {
    const ep = painter?.entryPaint;
    for (const mode of Object.keys(SMOOTH_TOOLS)) {
      const tool = vectorTool(ep, mode);
      if (tool && !tool.__evrSmooth && typeof tool.onMouseDown === 'function' && typeof tool.onMouseDrag === 'function' &&
        typeof tool.onMouseUp === 'function') wrapSmoothTool(ep, tool, mode);
      if (mode === 'ERASER' && tool && !tool.__evrErase && typeof tool.erasePath === 'function') wrapVectorErase(ep, tool);
      const raster = bitmapTool(ep, mode);
      if (raster && !raster.__evrSmooth && typeof raster.onMouseDown === 'function' && typeof raster.onMouseDrag === 'function' &&
        typeof raster.onMouseUp === 'function') wrapBitmapSmooth(ep, raster, mode);
    }
  }
  // 엔트리 벡터 지우개(erasePath, entry-paint 260921)는 닫힌 도형에서 지우개 모양을 뺀 묶음 경로를 만든 뒤 조각을 하나씩 꺼내 위에
  // 얹고, 비운 묶음 경로는 그대로 남긴다(보이지 않는 빈 항목 — 다음 지우기에선 빈 경로가 됨). 열린 선은 자른 조각이 따로 선이 된다.
  // 확장은 그림 층 맨 위 항목 하나를 레이어 하나로 세므로 지울 때마다 레이어가 불어났다(사용자 제보 "지 맘대로 늘어남", 확장 없는
  // 엔트리에서 사각형 하나를 두 번 지우면 7개). 지운 직후(엔트리 되돌리기 기록 전) 조각을 원래 항목 하나로 되돌리고 빈 항목을 지운다:
  // 닫힌 도형은 비운 묶음 경로에 조각을 다시 넣고(모양·구멍 그대로), 열린 선은 엔트리 묶기(Wn)처럼 묶음 하나로 모은다.
  function wrapVectorErase(ep, tool) {
    tool.__evrErase = true;
    const original = tool.erasePath;
    tool.erasePath = function (shape) {
      const P = ep.paper, PI = P.PathItem.prototype, IP = P.Item.prototype, PP = P.Path.prototype;
      const subtract = PI.subtract, insertAbove = IP.insertAbove, splitAt = PP.splitAt;
      const results = new Map(); // subtract 결과 → 엔트리가 그 위에 꺼내 얹은 조각
      const splitRoot = new Map(); // 자른 조각 → 원래 열린 선
      PI.subtract = function (...args) { const result = subtract.apply(this, args); if (result && !results.has(result)) results.set(result, []); return result; };
      IP.insertAbove = function (item, ...rest) { results.get(item)?.push(this); return insertAbove.call(this, item, ...rest); };
      PP.splitAt = function (...args) { const piece = splitAt.apply(this, args); if (piece) splitRoot.set(piece, splitRoot.get(this) || this); return piece; };
      try { return original.call(this, shape); }
      finally {
        PI.subtract = subtract; IP.insertAbove = insertAbove; PP.splitAt = splitAt;
        try { tidyErased(P, results, splitRoot); } catch (error) { console.warn('[entry-vector-rig] 지우개 조각 정리', error); }
        try { eraseRasters(P, paintLayer(ep)?.layer, shape); } catch (error) { console.warn('[entry-vector-rig] 지우개 이미지 지우기', error); }
      }
    };
  }
  // 엔트리 벡터 지우개는 도형(경로)만 빼고 그림(이미지) 항목은 그대로 둔다. 끄는 동안 미리보기는 그림 층 전체를 뚫어 보여, 이미지도
  // 지워지는 것처럼 보이다가 놓으면 되살아났다(사용자 제보, 엔트리 원래 지우개도 흰 미리보기로 덮었다가 놓으면 다시 나타남). 지운 모양을
  // 그 이미지 화소에서도 뺀다: 지우개 모양(그림 층 좌표)을 그 그림의 화소 좌표로 옮겨(paper Raster는 가운데가 원점, 1단위 = 1화소)
  // destination-out으로 칠한다. 엔트리가 바로 뒤에 남기는 되돌리기 기록에 바뀐 화소가 들어간다.
  function eraseRasters(P, layer, shape) {
    if (!layer || !shape) return;
    const area = shape.bounds;
    for (const raster of layer.getItems({ class: P.Raster })) {
      if (isLayerHelper(raster) || !raster.width || !raster.height) continue;
      let toLayer = raster.matrix.clone();
      for (let parent = raster.parent; parent && parent !== layer; parent = parent.parent) toLayer = parent.matrix.clone().append(toLayer);
      const w = raster.width / 2, h = raster.height / 2;
      const corners = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => toLayer.transform(new P.Point(x, y)));
      const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
      if (!area.intersects(new P.Rectangle(new P.Point(Math.min(...xs), Math.min(...ys)), new P.Point(Math.max(...xs), Math.max(...ys))))) continue;
      const m = new P.Matrix().translate(raster.width / 2, raster.height / 2).append(toLayer.inverted()).append(shape.matrix);
      const ctx = raster.getContext(true);
      ctx.save();
      ctx.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.fill(new Path2D(shape.pathData));
      ctx.restore();
    }
  }
  function tidyErased(P, results, splitRoot) {
    for (const [result, list] of results) {
      if (!result.isInserted()) continue;
      const pieces = list.filter(piece => piece.isInserted() && piece.parent === result.parent);
      if (result instanceof P.CompoundPath && !result.children.length && pieces.length > 1) {
        // 조각 경로는 묶음 경로 안으로 옮기고, 구멍이 있던 조각(묶음 경로)은 속만 옮긴 뒤 빈 껍데기를 지운다
        for (const piece of pieces) result.addChildren(piece instanceof P.CompoundPath ? piece.removeChildren() : [piece]);
        for (const piece of pieces) if (piece instanceof P.CompoundPath) piece.remove();
      } else if (result.isEmpty()) result.remove();
    }
    const groups = new Map();
    for (const [piece, root] of splitRoot) { if (!groups.has(root)) groups.set(root, [root]); groups.get(root).push(piece); }
    for (const all of groups.values()) {
      const alive = all.filter(path => path.isInserted() && !path.isEmpty());
      const parent = alive[0]?.parent;
      if (alive.length < 2 || alive.some(path => path.parent !== parent)) continue;
      alive.sort((a, b) => a.index - b.index);
      const group = new P.Group({ insert: false });
      group.applyMatrix = false;
      for (const key of ['evrName', 'evrClip']) if (alive[0].data?.[key] !== undefined) { group.data[key] = alive[0].data[key]; for (const path of alive) delete path.data[key]; }
      parent.insertChild(alive[0].index, group);
      group.addChildren(alive);
      group.pivot = group.bounds.center;
    }
  }
  // 벡터 붓·지우개: 누르기는 엔트리 그대로(시작 원 + 획 만들기 brushItemMaker), 끌기는 엔트리 끌기(그림 좌표 간격·throttle) 대신 거른 점을
  // 같은 획 만들기에 넣고, 놓기 전에 남은 점까지 넣는다. 놓기(엔트리 onMouseUp: 놓은 자리까지 막대 → 합치기 → 같은 색 붓 획 합치기·
  // 지우개로 빼기 → 되돌리기 기록)는 엔트리 그대로다.
  function wrapSmoothTool(ep, tool, mode) {
    tool.__evrSmooth = true;
    const down = tool.onMouseDown, drag = tool.onMouseDrag, up = tool.onMouseUp;
    const endStroke = () => {
      const stroke = tool.__evrStroke;
      tool.__evrStroke = null;
      try { stroke?.stop(); } finally { stroke?.preview?.end(); }
    };
    tool.onMouseDown = function (event) {
      endStroke(); // 앞 획이 놓기 없이 남았으면(포인터 취소 등) 넣던 점과 미리보기만 정리 — 엔트리 원래 도구와 같은 처리
      const entryLayer = ep.project.activeLayer, known = new Set(entryLayer?.children || []);
      const result = down.call(this, event);
      const maker = tool.brushItemMaker;
      if (!smoothBrush.on || !maker || !window.oneEuroFilter?.OneEuroFilter) return result;
      try {
        const state = paintStore()?.getState().tool;
        const width = mode === 'ERASER' ? state?.userEraserSize : state?.userBrushWidth;
        if (!(width > 0)) return result;
        const layer = paintLayer(ep)?.layer;
        const preview = mode === 'ERASER' && layer ? new EraserPreview(ep, layer, entryLayer, known, event.point, width) : null;
        const draw = (a, b) => {
          if (tool.brushItemMaker !== maker) return;
          maker.move({ point: b });
          preview?.add(b);
        };
        // 엔트리 간격 = 엔트리가 누를 때 거는 끌기 간격(3+굵기/5, 그림 좌표)
        const stroke = new SmoothFeed(ep, event, width, draw, smoothSegment(3 + Math.floor(width / 5), ep.project.view.zoom), `VECTOR_${mode}`);
        stroke.preview = preview;
        tool.__evrStroke = stroke;
      } catch (error) {
        console.warn('[entry-vector-rig] 부드러운 붓', error);
        endStroke();
      }
      return result;
    };
    tool.onMouseDrag = function (event) {
      const stroke = tool.__evrStroke;
      if (!stroke || !tool.brushItemMaker) return drag.call(this, event);
      stroke.move(event);
      return undefined;
    };
    tool.onMouseUp = function (event) {
      // 지우개는 놓을 때 그림 층 항목에서 지울 모양을 빼므로 미리보기가 먼저 빠져야 한다
      try { endStroke(); } catch (error) { console.warn('[entry-vector-rig] 부드러운 붓', error); }
      return up.call(this, event);
    };
  }
  // 붓·지우개 옵션 줄(엔트리 아래쪽 "펜 | 윤곽선 굵기 | 채우기 색상" 등) 끝에 부드럽게·보정을 붙인다(벡터·비트맵 같은 설정).
  // 엔트리 옵션 줄은 넘치면 옆으로 넘기는(화살표) 한 줄이고 끝 표식(#rightObserver)으로 끝을 안다 — 확장 옵션 상자는 그 앞에 둔다.
  // 확장 상자끼리는 차례를 다투지 않는다: 예전엔 비트맵 붓에서 붓 옵션과 사각 펜 옵션이 서로 끝 표식 바로 앞이어야 한다며 0.5초마다
  // 자리를 바꿔(요소를 옮기면 끌던 밀대가 놓이고 초점이 빠짐) 보정 밀대를 끄는 중에 끊겼다(검토로 찾음 2026-10-16).
  function placeOptionBox(bar, box) {
    const end = bar.querySelector(':scope > #rightObserver');
    if (box.parentElement === bar) {
      let next = box.nextElementSibling;
      while (next && next !== end && /(^|\s)evr-[\w-]+-opts(\s|$)/.test(next.className)) next = next.nextElementSibling;
      if (next === (end || null)) return;
    }
    bar.insertBefore(box, end || null);
  }
  function ensureBrushOptions(painter) {
    const ep = painter?.entryPaint, active = ep?.paper?.tool;
    const mode = Object.keys(SMOOTH_TOOLS).find(key => active && (active === vectorTool(ep, key) || active === bitmapTool(ep, key)));
    const bar = document.querySelector('#entryPainter .bottom_area > div');
    let box = document.querySelector('#entryPainter .evr-stroke-opts');
    if (!mode || !bar) { box?.remove(); return; }
    if (!box) box = buildBrushOptions();
    const title = box.querySelector('.evr-brush-title');
    if (title.textContent !== SMOOTH_TOOLS[mode]) title.textContent = SMOOTH_TOOLS[mode];
    placeOptionBox(bar, box);
    syncBrushOptions(box);
  }
  function buildBrushOptions() {
    const box = document.createElement('div');
    box.className = 'evr-brush-opts evr-stroke-opts';
    const smooth = button('부드럽게', () => { smoothBrush.on = !smoothBrush.on; syncBrushOptions(box); },
      { class: 'evr-brush-toggle evr-brush-smooth',
        title: '확장: 촘촘한 입력으로 받아 매끄러운 곡선으로 그리고 지움(끄면 엔트리 원래 붓·지우개)' });
    const level = document.createElement('label');
    level.className = 'evr-brush-level';
    level.title = '손떨림 보정: 끔~5. 클수록 떨림을 많이 거르지만 선이 조금 늦게 따라옴';
    const text = document.createElement('span');
    text.textContent = '보정';
    const range = document.createElement('input');
    Object.assign(range, { type: 'range', min: '0', max: String(BRUSH_MIN_CUTOFF.length - 1), step: '1' });
    range.addEventListener('input', () => { smoothBrush.level = Number(range.value); syncBrushOptions(box); });
    const value = document.createElement('b');
    level.append(text, range, value);
    // 엔트리 옵션처럼 위에 이름, 아래에 조작
    const title = document.createElement('span');
    title.className = 'evr-brush-title';
    title.textContent = '부드러운 붓';
    const row = document.createElement('div');
    row.className = 'evr-brush-row';
    row.append(smooth, level);
    box.append(title, row);
    // 보정 막대에서 쓰는 방향키 등만 엔트리 단축키(문서 keydown)로 넘어가지 않게. 다른 키(Ctrl+Z 등)는 그대로 둔다.
    range.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        event.stopPropagation();
    });
    return box;
  }
  function syncBrushOptions(box) {
    const pressed = (node, on) => {
      if (node.getAttribute('aria-pressed') !== String(on)) node.setAttribute('aria-pressed', String(on));
    };
    pressed(box.querySelector('.evr-brush-smooth'), smoothBrush.on);
    const range = box.querySelector('input');
    if (Number(range.value) !== smoothBrush.level) range.value = String(smoothBrush.level);
    const label = smoothBrush.level ? String(smoothBrush.level) : '끔';
    const value = box.querySelector('.evr-brush-level b');
    if (value.textContent !== label) value.textContent = label;
    if (box.dataset.off !== String(!smoothBrush.on)) box.dataset.off = String(!smoothBrush.on);
  }
  // ---- 비트맵 사각 펜·투명 잠금 ----
  // 엔트리 비트맵 붓(entry-paint 260921)은 끄는 동안 drawRaster(인스턴스 함수)로 둥근 선을 번짐 없는 화소(getAliasingRaster)로
  // 만들어 그림 층 안 임시 묶음(tempGroup)에 넣고, 놓을 때 조각을 그림 층으로 옮긴 뒤 그림 층 전체를 한 장으로 굽는다.
  // 지우개는 그림 층 첫 그림(children[0]) 화소를 eraseRaster로 바로 지운다. 선 도구도 같은 임시 묶음을 쓴다.
  // 사각 펜: 픽셀 아트용으로 둥근 선 대신 브레젠험 직선(Bresenham 1965)의 칸마다 굵기 n×n 사각형을 그림 화소 칸에 맞춰
  // 찍는다(Aseprite 등 픽셀 편집기의 사각 펜 끝과 같은 모양). 굽기·되돌리기는 엔트리 것을 그대로 쓴다.
  // 투명 잠금(포토샵 "투명 픽셀 잠금"·프로크리에이트 "알파 잠금"): 임시 묶음에 들어오는 조각마다 source-atop을 걸어 칠해진
  // 곳에만 그려지게 한다. 묶음에만 걸면 엔트리가 조각을 꺼내 굽는 순간 사라진다(실제 엔트리 실험: 밖 4,052화소 → 조각마다면 0).
  // 엔트리 붓 색·굵기는 그림판 상태 저장소(redux, 모듈 안)에 있어 그림판 화면 요소의 React fiber로 읽는다. 쓰는 곳은 벡터 레이어 창의
  // 고르기(SELECT_ITEMS·CHANGE_TOOL_MODE, 엔트리가 쓰는 것과 같은 동작)와 모드 바꾸기 감지(hookModeSwitch — dispatch를 감싸 보기만 함)뿐.
  // alphaLock: 지금 쓰는 값(레이어가 있으면 지금 레이어 값), tabLock: 레이어 없는 모양에서 고른 이 탭 동안의 값. 예전엔 하나뿐이라 레이어 모양에서
  // 켠 잠금이 레이어 없는 다음 모양에 그대로 남아 붓이 칠해진 곳에만 그려졌다(검토로 찾음 2026-10-16).
  const pixelPen = { square: false, alphaLock: false, tabLock: false };
  const PEN_TOOLS = { BRUSH: '비트맵 붓', ERASER: '비트맵 지우개', LINE: '비트맵 선' };
  let paintStoreCache = null;
  function paintStore() {
    try { if (paintStoreCache?.getState()?.tool) return paintStoreCache; } catch { paintStoreCache = null; }
    const el = document.querySelector('#entryPainter .canvas_area');
    const key = el && Object.keys(el).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    for (let fiber = key && el[key], depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
      const store = fiber.memoizedProps?.store || fiber.memoizedProps?.value?.store;
      try { if (store?.getState?.()?.tool && store.getState().paint) return (paintStoreCache = store); } catch {}
    }
    return null;
  }
  function bitmapTool(ep, mode) {
    return ep?.paper?.tools?.find(tool => tool.MY_MODE?.toolMode === mode && tool.MY_MODE?.graphicsMode === 'BITMAP') || null;
  }
  // 두 점(그림 화소 칸) 사이 직선 칸들 — Zingl 브레젠험(vendor/bresenham-zingl.js, 양 끝 칸 포함)
  function linePixels(x0, y0, x1, y1) {
    const points = [];
    window.__evrBresenham.line(x0, y0, x1, y1, (x, y) => { points.push([x, y]); });
    return points;
  }
  // 그림 층 화소 칸(엔트리 비트맵은 그림 좌표 1 = 화소 1, 정수 자리)에 맞춘 사각 찍기 조각
  function squareStamp(ep, from, to, size, color) {
    const n = Math.max(1, Math.round(size)), half = Math.floor(n / 2);
    const points = linePixels(Math.floor(from.x), Math.floor(from.y), Math.floor(to.x), Math.floor(to.y));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const left = Math.min(...xs) - half, top = Math.min(...ys) - half;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...xs) - Math.min(...xs) + n;
    canvas.height = Math.max(...ys) - Math.min(...ys) + n;
    const g = canvas.getContext('2d');
    g.fillStyle = color;
    for (const [x, y] of points) g.fillRect(x - half - left, y - half - top, n, n);
    const raster = new ep.paper.Raster({ canvas, insert: false });
    raster.position = new ep.paper.Point(left + canvas.width / 2, top + canvas.height / 2);
    return raster;
  }
  // 투명 잠금: 지금 임시 묶음 조각과 앞으로 들어올 조각에 source-atop
  function lockTempGroup(tool) {
    const group = tool.tempGroup;
    if (!pixelPen.alphaLock || !group || group.__evrLocked) return;
    group.__evrLocked = true;
    group.children.forEach(item => { item.blendMode = 'source-atop'; });
    const add = group.addChild;
    group.addChild = function (item, ...rest) {
      if (item) item.blendMode = 'source-atop';
      return add.call(this, item, ...rest);
    };
  }
  function ensurePixelPen(painter) {
    const ep = painter?.entryPaint;
    const brush = bitmapTool(ep, 'BRUSH'), eraser = bitmapTool(ep, 'ERASER'), line = bitmapTool(ep, 'LINE');
    if (brush && !brush.__evrPixelPen && typeof brush.drawRaster === 'function' && typeof brush.onMouseDown === 'function') {
      brush.__evrPixelPen = true;
      const draw = brush.drawRaster, down = brush.onMouseDown;
      brush.drawRaster = function (from, to, ...rest) {
        const tool = paintStore()?.getState().tool;
        if (!pixelPen.square || !tool?.userFillColor || !from || !to) return draw.call(this, from, to, ...rest);
        if (this.tempGroup) this.tempGroup.addChild(squareStamp(ep, from, to, tool.userBrushWidth, tool.userFillColor));
        this.lastPoint = to;
      };
      brush.onMouseDown = function (event) { const result = down.call(this, event); lockTempGroup(this); return result; };
    }
    if (line && !line.__evrPixelPen && typeof line.onMouseDown === 'function') {
      line.__evrPixelPen = true;
      const down = line.onMouseDown;
      line.onMouseDown = function (event) { const result = down.call(this, event); lockTempGroup(this); return result; };
    }
    if (eraser && !eraser.__evrPixelPen && typeof eraser.eraseRaster === 'function') {
      eraser.__evrPixelPen = true;
      const erase = eraser.eraseRaster;
      // 사각 지우개: 지울 칸을 그림 화소에서 바로 투명하게(엔트리 지우개처럼 children[0]을 고침)
      eraser.eraseRaster = function (from, to, ...rest) {
        const raster = this.targetRaster;
        if (!pixelPen.square || !(raster instanceof ep.paper.Raster) || !from || !to) return erase.call(this, from, to, ...rest);
        const n = Math.max(1, Math.round(this.eraserSize || 1)), half = Math.floor(n / 2);
        const at = point => raster.globalToLocal(point).add(new ep.paper.Point(raster.width / 2, raster.height / 2));
        const a = at(from), b = at(to);
        const points = linePixels(Math.floor(a.x), Math.floor(a.y), Math.floor(b.x), Math.floor(b.y));
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const left = Math.max(0, Math.min(...xs) - half), top = Math.max(0, Math.min(...ys) - half);
        const right = Math.min(raster.width, Math.max(...xs) - half + n), bottom = Math.min(raster.height, Math.max(...ys) - half + n);
        if (right <= left || bottom <= top) return;
        const rect = new ep.paper.Rectangle(left, top, right - left, bottom - top);
        const image = raster.getImageData(rect), w = right - left;
        for (const [x, y] of points)
          for (let yy = Math.max(top, y - half); yy < Math.min(bottom, y - half + n); yy++)
            for (let xx = Math.max(left, x - half); xx < Math.min(right, x - half + n); xx++)
              image.data[((yy - top) * w + (xx - left)) * 4 + 3] = 0;
        raster.setImageData(image, new ep.paper.Point(left, top));
      };
    }
  }
  function ensurePixelPenOptions(painter) {
    const ep = painter?.entryPaint, active = ep?.paper?.tool;
    const mode = Object.keys(PEN_TOOLS).find(key => active && active === bitmapTool(ep, key));
    const bar = document.querySelector('#entryPainter .bottom_area > div');
    let box = document.querySelector('#entryPainter .evr-pen-opts');
    if (!mode || !bar) { box?.remove(); return; }
    if (!box) box = buildPixelPenOptions();
    box.dataset.mode = mode;
    const title = box.querySelector('.evr-brush-title');
    if (title.textContent !== PEN_TOOLS[mode]) title.textContent = PEN_TOOLS[mode];
    placeOptionBox(bar, box);
    syncPixelPenOptions(box);
  }
  function buildPixelPenOptions() {
    const box = document.createElement('div');
    box.className = 'evr-brush-opts evr-pen-opts';
    const title = document.createElement('span');
    title.className = 'evr-brush-title';
    const square = button('사각 펜', () => { pixelPen.square = !pixelPen.square; syncPixelPenOptions(box); },
      { class: 'evr-brush-toggle evr-pen-square',
        title: '확장: 펜 끝을 굵기만 한 사각형으로, 화소 칸에 맞춰 찍음(픽셀 아트용). 끄면 엔트리 원래 둥근 붓·지우개' });
    const lock = button('투명 잠금', () => { toggleAlphaLock(); syncPixelPenOptions(box); },
      { class: 'evr-brush-toggle evr-pen-lock',
        title: '확장: 이미 칠해진 곳에만 그림(투명한 곳은 그대로 — 선 밖으로 안 삐져나감). 붓·선·영역 채우기에 함께 적용' });
    const row = document.createElement('div');
    row.className = 'evr-brush-row';
    row.append(square, lock);
    box.append(title, row);
    return box;
  }
  function syncPixelPenOptions(box) {
    const pressed = (node, on) => {
      if (node.getAttribute('aria-pressed') !== String(on)) node.setAttribute('aria-pressed', String(on));
    };
    const square = box.querySelector('.evr-pen-square'), lock = box.querySelector('.evr-pen-lock');
    pressed(square, pixelPen.square);
    pressed(lock, pixelPen.alphaLock);
    // 사각 펜은 붓·지우개, 투명 잠금은 붓·선(지우개는 투명하게 만드는 도구라 잠그지 않음)
    square.hidden = box.dataset.mode === 'LINE';
    lock.hidden = box.dataset.mode === 'ERASER';
  }
  // 투명 잠금 켜고 끄기: 비트맵 레이어가 있으면 지금 레이어 속성(포토샵·프로크리에이트처럼 레이어마다), 없으면 이 탭 동안의 값
  function toggleAlphaLock() {
    const ep = window.Entry?.playground?.painter?.entryPaint, meta = layerMeta(ep);
    if (meta) {
      const layer = activeLayer(meta);
      layer.lock = !layer.lock;
      pixelPen.alphaLock = layer.lock;
      commitLayers(ep);
    } else pixelPen.alphaLock = pixelPen.tabLock = !pixelPen.alphaLock;
  }
  // ---- 비트맵 레이어(편집은 확장 전용, 보이는 것은 합친 그림) ----
  // 엔트리 비트맵은 그림 한 장이다(도구는 그림 층 첫 그림을 고치고, 붓·선은 획마다 그림 층 전체를 한 장으로 굽는다). 그래서
  // 지금 레이어만 엔트리 그림 층에 두고(엔트리 도구가 그대로 고침) 다른 레이어는 확장이 그림 사본으로 기억해 그림 층 밖에
  // 보이게만 둔다(그림 층 안에 두면 다음 획에 합쳐짐 — 실제 엔트리 실험).
  // 목록 상태(순서·이름·보이기·불투명도·클리핑·투명 잠금·지금 레이어·그림 참조)는 그림 층 data에 둔다. 엔트리 되돌리기 기록은
  // 그림 층을 통째로(exportJSON) 남기므로 되돌리면 지금 레이어 그림과 목록 상태가 같이 돌아온다(실험). 그림 참조는 이 탭에서
  // 만든 사본(layerCache, 바꾸지 않음)을 가리킨다. 엔트리는 다른 모양을 열어도 그림 층 data를 지우지 않아(실험) 열 때마다 새로 정한다.
  // 클리핑 마스크는 포토샵 규칙: 클리핑 레이어는 바로 아래 기준 레이어(클리핑 아닌 것)의 칠해진 모양 안에서만 보이고, 기준
  // 레이어의 불투명도가 묶음 전체에 걸린다. 화면에서는 잘라 보이는 층을 따로 합성(opacity .99999)하고 클리핑 레이어에 source-atop을
  // 건다 — 기준 묶음 아래 레이어는 그 층 밖(아래)에 둬 기준에만 잘리게 한다. 그림 층에 건 합성 모드·불투명도는 엔트리가 그림 층을
  // 굽는 동안만 끈다(켜 두면 굽기에 들어가 지금 레이어 그림이 통째로 지워짐 — 실험).
  // 저장: 보이는 레이어를 합친 그림을 저장하는 동안만 그림 층에 넣어 엔트리 저장(크기·중심·PNG)을 그대로 태우고, 같은 저장 요청에
  // 레이어 원본 SVG(<metadata> 안에 레이어 PSD, 보이는 것은 합친 그림 한 장)를 붙인다. 엔트리 서버는 PNG는 보낸 합친 그림,
  // SVG는 <metadata>·<defs>를 그대로 두고, 확장 없는 엔트리 편집기는 그 SVG에서 합친 그림만 보인다(8×8 시험 업로드·실험 — 그때는
  // 레이어를 <defs> PNG로 넣었음, PSD 넣은 SVG의 서버 왕복은 아직 안 해 봄). 실행 화면은 PNG.
  const LAYERS = 'evrLayers', LAYER_MARK = 'entryVectorLayers', LAYER_SVG = 'entryrootLayers';
  const layerCache = new Map();
  let layerSeq = 0;
  const layerUid = prefix => `${prefix}${Date.now().toString(36)}${(layerSeq++).toString(36)}`;
  // signature: 지금 화면 표시의 요약('' = 레이어 목록 없음), null = 다시 맞추기. 예전엔 다시 맞추기도 ''라 레이어 모양에서 레이어 없는
  // 모양으로 바꾸면(또는 레이어 추가를 되돌리면) 둘이 같다고 보고 표시를 안 지워, 앞 모양의 다른 레이어·클리핑 합성이 다음 모양에
  // 남았다(사용자 제보 2026-10-16 "클리핑이 모양마다 따로 안 됨" — 재현: 앞 모양 바탕 원이 다음 모양 뒤에 남음).
  const layerUi = { ep: null, signature: null, displays: [], under: null, panel: null, open: false, importing: null,
    convert: null, vectorPick: null, vectorEpoch: 0, thumbs: new WeakMap(), panelRows: null };
  // 그림 층 data의 목록(모드는 보지 않음 — 모드를 바꾸는 순간에는 엔트리 상태가 이미 새 모드다)
  function storedLayerMeta(layer) {
    const meta = layer?.data?.[LAYERS];
    if (!meta || !Array.isArray(meta.layers) || !meta.layers.length || !meta.layers.some(item => item.id === meta.active)) return null;
    return meta;
  }
  function layerMeta(ep) {
    const parts = ep?.mode === 'BITMAP' && paintLayer(ep);
    return parts ? storedLayerMeta(parts.layer) : null;
  }
  const activeLayer = meta => meta.layers.find(layer => layer.id === meta.active);
  // 레이어로 저장할 만한가: 둘 이상이거나, 한 장이라도 숨김·불투명도를 바꿈(투명 잠금은 편집 도움이라 따지지 않음)
  const layersMatter = meta => meta.layers.length > 1 || !meta.layers[0].visible || meta.layers[0].opacity !== 1;
  const copyCanvas = source => {
    const canvas = canvasOfSize(source.width, source.height);
    canvas.getContext('2d').drawImage(source, 0, 0);
    return canvas;
  };
  // 지금 레이어(그림 층 내용) 사본 { canvas, x, y } — 그림 좌표 왼쪽 위. 기준점 상자는 뺀다.
  function paintSnapshot(ep) {
    const layer = paintLayer(ep)?.layer;
    if (!layer) return null;
    const items = layer.children.filter(item => item.data?.entryVectorCanvasBox !== '1');
    if (!items.length) return null;
    const m = items[0].matrix;
    if (items.length === 1 && isRasterLayer(items[0]) && items[0].width && m.a === 1 && m.d === 1 && !m.b && !m.c) {
      const b = items[0].bounds;
      return { canvas: rasterCopy(items[0]), x: Math.round(b.x), y: Math.round(b.y) };
    }
    const boxes = layer.children.filter(item => item.data?.entryVectorCanvasBox === '1');
    boxes.forEach(item => { item.visible = false; });
    try {
      const raster = ownRasterize(layer, { resolution: 72, insert: false });
      if (!raster?.width || !raster.height) return null;
      const b = raster.bounds;
      return { canvas: rasterCopy(raster), x: Math.round(b.x), y: Math.round(b.y) };
    } finally { boxes.forEach(item => { item.visible = true; }); }
  }
  function ensureLayerMeta(ep) {
    const existing = layerMeta(ep);
    if (existing) return existing;
    const parts = ep?.mode === 'BITMAP' && paintLayer(ep);
    if (!parts) return null;
    const id = layerUid('L');
    const meta = { v: 1, active: id, layers: [{ id, name: '레이어 1', visible: true, opacity: 1, clip: false, lock: pixelPen.alphaLock, ref: null }] };
    // 모양 하나짜리 관절 기록(PNG로 다시 연 비트맵)은 첫 레이어(원래 그림) 것이다 — 옮겨 두지 않으면 레이어가 둘이 되면 안 보이고 저장 때 지워진다
    const c = context(), raster = parts.layer.children.find(isRasterLayer);
    const joints = c?.ep === ep && !raster?.data?.[BONES] ? pictureRigJoints(c) : null;
    if (joints) {
      const ref = layerUid('b');
      layerBones.set(ref, { bones: null, rest: null, joints });
      meta.layers[0].bonesRef = ref;
    }
    parts.layer.data[LAYERS] = meta;
    return meta;
  }
  // 레이어 뼈대: 참조 → { bones(그림 data 뼈대 글), rest(휘기 전 그림 data URL), joints(파일에서 읽은 관절, 아직 안 연 레이어) }.
  // 레이어 정보에는 참조만 둔다(레이어 정보는 화면 갱신마다 글로 바뀌어 비교되므로 큰 글을 넣지 않는다).
  const layerBones = new Map();
  const layerBonesOf = layer => (layer?.bonesRef && layerBones.get(layer.bonesRef)) || null;
  // 지금 레이어 그림을 사본으로 남기고 참조를 바꾼다(레이어를 바꾸거나 저장·합치기 전에)
  function storeActive(ep, meta) {
    const shot = paintSnapshot(ep), layer = activeLayer(meta);
    // 뼈대는 그림 data에 있고 레이어를 바꾸면 그림을 새로 만들므로(putActive) 레이어 쪽으로 옮겨 둔다 — 레이어마다 뼈대
    const raster = paintLayer(ep)?.layer.children.find(isRasterLayer), bones = raster?.data?.[BONES] || null;
    // 그림에 뼈대가 없다고 지우지 않는다 — 필터처럼 그림을 새로 바꾸는 기능도 data를 비운다. 뼈를 모두 지울 때만 deleteJoint가 지운다.
    if (bones) {
      const ref = layerUid('b');
      layerBones.set(ref, { bones, rest: raster.data[BITMAP_REST] || null, joints: null });
      layer.bonesRef = ref;
    }
    if (!shot) { layer.ref = null; return; }
    const ref = layerUid('r');
    layerCache.set(ref, shot);
    layer.ref = ref;
  }
  const layerContent = (ep, meta, layer) => layer.ref ? layerCache.get(layer.ref) || null : null;
  // 그 레이어 그림을 엔트리 그림 층에 넣는다(사본을 넣음 — 엔트리 지우개는 그림을 그 자리에서 고친다). 빈 레이어는 작업 영역만 한 투명 그림.
  function layerRaster(ep, layer) {
    const stage = paintLayer(ep).stage, P = ep.paper;
    const content = layer.ref && layerCache.get(layer.ref);
    const canvas = content ? copyCanvas(content.canvas) : canvasOfSize(Math.max(1, Math.round(stage.width)), Math.max(1, Math.round(stage.height)));
    const x = content ? content.x : Math.round(stage.x), y = content ? content.y : Math.round(stage.y);
    const raster = new P.Raster({ canvas, insert: false });
    raster.position = new P.Point(x + canvas.width / 2, y + canvas.height / 2);
    return raster;
  }
  function putActive(ep, layer) {
    const parts = paintLayer(ep), raster = layerRaster(ep, layer), kept = layerBonesOf(layer);
    if (kept?.bones) raster.data[BONES] = kept.bones;
    if (kept?.bones && kept.rest) raster.data[BITMAP_REST] = kept.rest;
    parts.layer.removeChildren();
    parts.layer.addChild(raster);
  }
  function clipGroups(layers) {
    const groups = [];
    for (const layer of layers) {
      if (layer.clip && groups.length) groups[groups.length - 1].members.push(layer);
      else groups.push({ members: [layer] });
    }
    return groups;
  }
  // 묶음 하나(기준 + 클리핑 레이어들)를 한 장으로: 기준 모양 안에서만 클리핑 레이어(각자 불투명도). 기준 불투명도는 부르는 쪽이 건다.
  function groupComposite(group, contentOf) {
    const base = group.members[0];
    const b = base.visible && contentOf(base);
    if (!b) return null;
    // 클리핑 레이어가 없으면 기준 그림을 그대로(부르는 쪽은 읽기만 함) — 묶음마다 복사하면 레이어가 많을 때 느렸다(실측 1000장 110ms)
    if (group.members.length < 2) return { canvas: b.canvas, x: b.x, y: b.y, opacity: base.opacity };
    const canvas = copyCanvas(b.canvas), g = canvas.getContext('2d');
    for (const layer of group.members.slice(1)) {
      const c = layer.visible && contentOf(layer);
      if (!c) continue;
      g.globalAlpha = layer.opacity;
      g.globalCompositeOperation = 'source-atop';
      g.drawImage(c.canvas, c.x - b.x, c.y - b.y);
    }
    return { canvas, x: b.x, y: b.y, opacity: base.opacity };
  }
  // 묶음 그림들({ canvas, x, y, opacity }, 아래부터)을 차례로 겹친 한 장 { canvas, x, y }(없으면 null)
  function flattenParts(parts) {
    if (!parts.length) return null;
    const left = Math.min(...parts.map(p => p.x)), top = Math.min(...parts.map(p => p.y));
    const right = Math.max(...parts.map(p => p.x + p.canvas.width)), bottom = Math.max(...parts.map(p => p.y + p.canvas.height));
    const canvas = canvasOfSize(right - left, bottom - top), g = canvas.getContext('2d');
    for (const part of parts) { g.globalAlpha = part.opacity; g.drawImage(part.canvas, part.x - left, part.y - top); }
    return { canvas, x: left, y: top };
  }
  // 보이는 레이어 전부를 합친 그림 { canvas, x, y } (지금 레이어는 먼저 사본으로 남긴 뒤 부른다)
  function composeLayers(ep, meta) {
    return flattenParts(clipGroups(meta.layers).map(group => groupComposite(group, layer => layerContent(ep, meta, layer))).filter(Boolean));
  }
  function clearLayerDisplays(ep) {
    layerUi.displays.forEach(item => item.remove());
    layerUi.displays = [];
    layerUi.under?.remove();
    layerUi.under = null;
    const parts = ep && paintLayer(ep);
    if (parts) {
      if (parts.layer.blendMode !== 'normal') parts.layer.blendMode = 'normal';
      if (parts.layer.opacity !== 1) parts.layer.opacity = 1;
      if (parts.layer.parent.opacity !== 1) parts.layer.parent.opacity = 1;
    }
  }
  function drawLayerDisplays(ep, meta) {
    clearLayerDisplays(ep);
    if (!meta || meta.layers.length < 2 && meta.layers[0].visible && meta.layers[0].opacity === 1) return;
    const parts = paintLayer(ep), P = ep.paper, paint = parts.layer, clip = paint.parent;
    const display = (content, opacity, blend) => {
      const raster = new P.Raster({ canvas: content.canvas, insert: false });
      raster.position = new P.Point(content.x + content.canvas.width / 2, content.y + content.canvas.height / 2);
      raster.opacity = opacity;
      if (blend) raster.blendMode = blend;
      raster.locked = true;
      raster.data.evrLayerDisplay = true;
      return raster;
    };
    const groups = clipGroups(meta.layers);
    const gi = groups.findIndex(group => group.members.some(layer => layer.id === meta.active));
    const contentOf = layer => layerContent(ep, meta, layer);
    // 지금 묶음보다 아래 묶음들: 잘라 보이는 층 밖(아래)에 무대 틀로 잘라 둔다(지금 묶음의 클리핑이 이것까지 쓰지 않게).
    // 아래·위 묶음은 각각 미리 한 장으로 겹쳐 둔다 — 묶음마다 한 장씩 두면 화면을 다시 그릴 때마다 레이어 수만큼 그려 레이어가 많으면
    // 붓질이 끊겼다(사용자 요청 10-18 "랙 안 걸릴 방법", 실측 1000장: 붓질 중 233ms 프레임). 포토샵·크리타처럼 지금 레이어 아래·위 투영을
    // 한 장씩 두는 방식.
    const below = flattenParts(groups.slice(0, gi).map(group => groupComposite(group, contentOf)).filter(Boolean));
    if (below) {
      const mask = clip.children.find(item => item.className === 'Shape');
      const under = new P.Group({ insert: false, clipped: true,
        children: [mask.clone({ insert: false }), display(below, 1)] });
      under.locked = true;
      under.data.evrLayerDisplay = true;
      clip.parent.insertChild(clip.index, under);
      layerUi.under = under;
    }
    const group = groups[gi], at = group.members.findIndex(layer => layer.id === meta.active);
    const base = group.members[0];
    let after = paint.index + 1;
    group.members.forEach((layer, i) => {
      if (i === at) return;
      const content = layer.visible && (i === 0 || base.visible) && contentOf(layer);
      if (!content) return;
      const raster = display(content, layer.opacity, i > 0 ? 'source-atop' : null);
      if (i < at) { clip.insertChild(paint.index, raster); after++; } else clip.insertChild(after++, raster);
      layerUi.displays.push(raster);
    });
    const active = group.members[at];
    paint.opacity = active.visible && (at === 0 || base.visible) ? active.opacity : 0;
    if (at > 0) paint.blendMode = 'source-atop';
    if (group.members.length > 1) clip.opacity = 0.99999;
    const above = flattenParts(groups.slice(gi + 1).map(upper => groupComposite(upper, contentOf)).filter(Boolean));
    if (above) {
      const raster = display(above, 1);
      clip.insertChild(after++, raster);
      layerUi.displays.push(raster);
    }
  }
  // 그림 층 감싸기: 굽는 동안 화면용 합성 모드·불투명도 끄기, 되돌리기(importJSON) 뒤 다시 맞추기, 모양을 열 때 목록 상태 정하기,
  // 모드를 바꿀 때 레이어 남기기(beginLayerConvert가 준비한 것 — 엔트리 변환 한가운데서 한 번만)
  function hookLayerPaint(ep) {
    const layer = paintLayer(ep)?.layer;
    if (!layer || own(layer, '__evrLayerHook')) return;
    Object.defineProperty(layer, '__evrLayerHook', { value: true });
    const rasterize = layer.rasterize, importJSON = layer.importJSON, addChild = layer.addChild, removeChildren = layer.removeChildren;
    layer.removeChildren = function (...args) {
      const convert = layerUi.convert;
      const removed = removeChildren.apply(this, args);
      // 엔트리가 모드 값을 바꾼 뒤의 비우기만(그 전, 선택 비우기 때 비트맵 선택 조각을 굽는 비우기는 아님 — 실제 엔트리 재현)
      if (convert?.to === 'VECTOR' && convert.layer === this && !args.length && ep.mode === 'VECTOR') {
        layerUi.convert = null;
        try { finishToVector(ep, this, convert); }
        catch (error) { console.warn('[entry-vector-rig] 레이어 유지(비트맵 → 벡터) 실패', error); }
      }
      return removed;
    };
    layer.rasterize = function (...args) {
      const convert = layerUi.convert;
      if (convert?.to === 'BITMAP' && convert.layer === this && ep.mode === 'BITMAP') {
        layerUi.convert = null;
        try {
          const raster = finishToBitmap(ep, this, convert);
          if (raster) return raster;
          console.warn('[entry-vector-rig] 레이어 유지(벡터 → 비트맵): 엔트리 조각 수가 달라 엔트리처럼 합칩니다');
        } catch (error) { console.warn('[entry-vector-rig] 레이어 유지(벡터 → 비트맵) 실패 — 엔트리처럼 합칩니다', error); }
        // 미리 켜 둔 숨김·불투명도를 조각에 되돌려 합친다(조각 수가 맞을 때 — 클리핑은 못 살림)
        try { keepConvertLook(this, convert); } catch (error) { console.warn('[entry-vector-rig] 레이어 모습 되돌리기', error); }
      }
      const blend = this.blendMode, opacity = this.opacity;
      if (blend !== 'normal') this.blendMode = 'normal';
      if (opacity !== 1) this.opacity = 1;
      try { return rasterize.apply(this, args); } finally {
        if (blend !== 'normal') this.blendMode = blend;
        if (opacity !== 1) this.opacity = opacity;
      }
    };
    layer.importJSON = function (...args) {
      // paper importJSON은 기록에 있는 칸만 덮는다. 레이어를 처음 만들기 전 기록에는 레이어 목록 칸이 없어(빈 data는 기록에서 빠짐)
      // 첫 레이어 조작을 되돌려도 목록이 남았다(재현 2026-10-16: 추가 → 되돌리기 뒤에도 2장). 기록에 없으면 목록도 지운다.
      const json = args[0];
      const carried = typeof json === 'string' ? json.includes(`"${LAYERS}"`) : json?.[1]?.data?.[LAYERS] !== undefined;
      const result = importJSON.apply(this, args);
      if (!carried && this.data && LAYERS in this.data) delete this.data[LAYERS];
      layerUi.signature = null;
      try { refreshLayers(ep); } catch (error) { console.warn('[entry-vector-rig] 레이어 되돌리기', error); }
      return result;
    };
    layer.addChild = function (item, ...rest) {
      // 비트맵 → 벡터: 레이어 항목을 이미 넣었으니 엔트리가 넣는 지금 레이어 그림(같은 것)은 버린다
      if (layerUi.convert?.dropAdd && layerUi.convert.layer === this) {
        layerUi.convert = null;
        return item;
      }
      const pending = layerUi.importing;
      if (pending && isRasterLayer(item)) {
        layerUi.importing = null;
        if (pending.meta) this.data[LAYERS] = pending.meta;
        else delete this.data[LAYERS];
        layerUi.signature = null;
      }
      return addChild.call(this, item, ...rest);
    };
  }
  // 레이어를 바꾼 뒤: 엔트리 되돌리기 기록을 남기고(그림 층 data·지금 그림이 같이 기록됨) 화면·목록을 다시 맞춘다
  function commitLayers(ep) {
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 레이어: 되돌리기 기록을 남기지 못함');
    layerUi.signature = null;
    refreshLayers(ep);
  }
  function refreshLayers(ep) {
    if (!ep?.project || !paintLayer(ep)) return;
    hookLayerPaint(ep);
    hookModeSwitch();
    if (!own(ep, '__evrLayerEpoch')) {
      Object.defineProperty(ep, '__evrLayerEpoch', { value: true });
      ep.on?.('SNAPSHOT_SAVED', () => { layerUi.vectorEpoch++; });
    }
    // 열기가 끝났는데 엔트리가 첫 그림을 넣는 순간을 못 잡았으면(그림 층을 새로 만든 경우 등) 지금 넣고 기록을 하나 남긴다
    const painter = window.Entry?.playground?.painter, pending = layerUi.importing;
    if (pending && painter && !painter.__evrLoading && pending.token === painter.__evrLoadToken) {
      layerUi.importing = null;
      if (pending.meta && ep.mode === 'BITMAP') {
        paintLayer(ep).layer.data[LAYERS] = pending.meta;
        commitLayers(ep);
        return;
      }
    }
    const meta = layerMeta(ep);
    pixelPen.alphaLock = meta ? !!activeLayer(meta).lock : pixelPen.tabLock;
    const stage = paintLayer(ep).stage;
    // 뼈대 모드(비트맵은 지금 레이어 한 장만 휨) 동안에도 다른 레이어는 보인다 — 예전엔 뼈대 모드면 표시를 지워 지금 레이어만 보였다(사용자 제보)
    const signature = meta ? JSON.stringify([meta, Math.round(stage.x), Math.round(stage.y), Math.round(stage.width), Math.round(stage.height)]) : '';
    if (layerUi.ep !== ep || layerUi.signature !== signature) {
      layerUi.ep = ep;
      layerUi.signature = signature;
      if (signature) drawLayerDisplays(ep, meta); else clearLayerDisplays(ep);
    }
    renderLayerPanel(ep, meta);
  }
  // ---- 레이어 조작(목록 위 = 앞) ----
  const layerName = meta => {
    const used = new Set(meta.layers.map(layer => layer.name));
    for (let n = meta.layers.length + 1; ; n++) if (!used.has(`레이어 ${n}`)) return `레이어 ${n}`;
  };
  function addLayer(ep) {
    const meta = ensureLayerMeta(ep);
    if (!meta) return;
    storeActive(ep, meta);
    const at = meta.layers.findIndex(layer => layer.id === meta.active);
    const layer = { id: layerUid('L'), name: layerName(meta), visible: true, opacity: 1, clip: false, lock: false, ref: null };
    meta.layers.splice(at + 1, 0, layer);
    meta.active = layer.id;
    putActive(ep, layer);
    commitLayers(ep);
  }
  function duplicateLayer(ep) {
    const meta = ensureLayerMeta(ep);
    if (!meta) return;
    storeActive(ep, meta);
    const at = meta.layers.findIndex(layer => layer.id === meta.active), source = meta.layers[at];
    const layer = { ...source, id: layerUid('L'), name: `${source.name} 복사` };
    meta.layers.splice(at + 1, 0, layer);
    meta.active = layer.id;
    putActive(ep, layer);
    commitLayers(ep);
  }
  // (뼈대 모드에 같은 이름 selectLayer가 있어 이름을 따로 둔다 — 같은 범위 함수 선언은 뒤의 것이 앞의 것을 말없이 덮는다)
  function selectBitmapLayer(ep, id) {
    const meta = layerMeta(ep);
    if (!meta || meta.active === id || !meta.layers.some(layer => layer.id === id)) return;
    storeActive(ep, meta);
    meta.active = id;
    putActive(ep, activeLayer(meta));
    commitLayers(ep);
  }
  function deleteLayer(ep) {
    const meta = layerMeta(ep);
    if (!meta || meta.layers.length < 2) return;
    const at = meta.layers.findIndex(layer => layer.id === meta.active);
    meta.layers.splice(at, 1);
    meta.active = meta.layers[Math.max(0, at - 1)].id;
    putActive(ep, activeLayer(meta));
    commitLayers(ep);
  }
  function moveLayer(ep, step) {
    const meta = layerMeta(ep);
    if (!meta) return;
    const at = meta.layers.findIndex(layer => layer.id === meta.active), to = at + step;
    if (to < 0 || to >= meta.layers.length) return;
    [meta.layers[at], meta.layers[to]] = [meta.layers[to], meta.layers[at]];
    commitLayers(ep);
  }
  // 레이어 창에서 손잡이로 끌어 놓은 자리로(목록 아래부터 번호, 되돌리기 기록 한 번)
  function moveLayerTo(ep, id, to) {
    const meta = layerMeta(ep);
    if (!meta) return;
    const from = meta.layers.findIndex(layer => layer.id === id);
    if (from < 0 || to < 0 || to >= meta.layers.length || from === to) return;
    const [layer] = meta.layers.splice(from, 1);
    meta.layers.splice(to, 0, layer);
    commitLayers(ep);
  }
  // 아래로 합치기(포토샵 "아래 레이어와 병합"): 지금 레이어를 불투명도·클리핑대로 아래 레이어에 그려 넣고 지운다
  function mergeLayerDown(ep) {
    const meta = layerMeta(ep);
    if (!meta) return;
    const at = meta.layers.findIndex(layer => layer.id === meta.active);
    if (at < 1) return;
    storeActive(ep, meta);
    const top = meta.layers[at], below = meta.layers[at - 1];
    const a = layerContent(ep, meta, below), b = top.visible ? layerContent(ep, meta, top) : null;
    if (b) {
      const left = Math.min(a ? a.x : b.x, b.x), up = Math.min(a ? a.y : b.y, b.y);
      const right = Math.max(a ? a.x + a.canvas.width : 0, b.x + b.canvas.width), down = Math.max(a ? a.y + a.canvas.height : 0, b.y + b.canvas.height);
      const canvas = canvasOfSize(right - left, down - up), g = canvas.getContext('2d');
      if (a) g.drawImage(a.canvas, a.x - left, a.y - up);
      g.globalAlpha = top.opacity;
      // 클리핑 레이어를 기준 레이어로 합칠 때만 기준 모양 안에(아래 레이어가 클리핑 레이어면 합친 것도 같은 기준에 잘린 채 남음)
      g.globalCompositeOperation = top.clip && !below.clip ? 'source-atop' : 'source-over';
      g.drawImage(b.canvas, b.x - left, b.y - up);
      const ref = layerUid('r');
      layerCache.set(ref, { canvas, x: left, y: up });
      below.ref = ref;
    }
    meta.layers.splice(at, 1);
    meta.active = below.id;
    putActive(ep, below);
    commitLayers(ep);
  }
  function setLayerProp(ep, id, key, value, commit = true) {
    const meta = layerMeta(ep), layer = meta?.layers.find(item => item.id === id);
    if (!layer || layer[key] === value) return;
    layer[key] = value;
    if (key === 'lock' && id === meta.active) pixelPen.alphaLock = !!value;
    if (commit) commitLayers(ep);
    else { layerUi.signature = null; refreshLayers(ep); }
  }
  // ---- 벡터 레이어: 엔트리 벡터 그림 층의 맨 위 항목 하나가 레이어 하나(뼈대 목록의 "레이어"와 같음) ----
  // 엔트리 벡터 편집(아무 도형이나 고르기, 앞으로·뒤로, 그룹·그룹 해제, 저장 SVG)은 그대로 두고, 레이어 창이 그 항목들을 비트맵 레이어와
  // 같은 모양으로 보여 주고 고친다. 고르기 = 엔트리 선택, 숨기기 = visible(저장 SVG visibility), 불투명도 = opacity, 순서 = 그림 층 순서,
  // 이름 = name과 data.evrName(엔트리 저장은 항목 복제본을 내보내는데 paper가 복제본 이름에 번호를 붙여 저장 SVG id가 바뀐다 — 실험).
  // 클리핑(포토샵 규칙, 비트맵 레이어와 같음): 클리핑 레이어(data.evrClip)는 바로 아래 기준 레이어(그 사이 클리핑 레이어는 건너 처음
  // 만나는 클리핑 아닌 레이어)의 칠해진 곳에서만 보인다. 레이어는 그대로 그림 층의 맨 위 항목이고 그릴 때만 자른다(hookClipDraw).
  // 예전엔 기준과 클리핑 레이어를 묶음 하나(data.evrClipStack)로 싸고 source-atop을 걸었는데, 엔트리는 묶음을 한 덩어리로 고르므로
  // (entry-paint 260921 getRootItem) 클리핑하면 무조건 그룹이 됐다(사용자 제보 — 위 레이어를 끌면 기준까지 움직이고 "그룹 해제"가
  // 켜짐). 옛 묶음은 열 때 푼다(normalizeVectorLayers). 저장 SVG에는 자르기가 안 남아 확장 없는 편집기로 열면 잘리지 않은 채 보이지만,
  // 실행 화면 PNG는 그림판 그리기 그대로라 잘려 있다. 다시 열면 data를 보고 되살린다.
  const CLIP_STACK = 'evrClipStack', CLIP_ISOLATE = .99999;
  const isLayerHelper = item => item?.data?.entryVectorCanvasBox === '1' || !!item?.data?.evrLayerDisplay || (!!item && strokePreview.has(item));
  const helperFast = item => strokePreview.has(item) || !!(item._data && (item._data.entryVectorCanvasBox === '1' || item._data.evrLayerDisplay));
  // 잘라 그릴 그림 층들(벡터 모드 그림 층 — 맨 위 항목만). 레이어 작은 그림처럼 자르지 않은 내용을 구울 때는 clipDrawOff를 올린다.
  const clipLayers = new WeakSet();
  let clipDrawOff = 0;
  const clipScratch = [null, null];
  const clipMaskCache = { base: null, param: null, key: '', canvas: null, rect: null }; // clipScratch[1]에 그려 둔 기준 모양(그리기 한 번 안에서만)
  function clipScratchCanvas(i, w, h) {
    const canvas = clipScratch[i] ||= document.createElement('canvas');
    if (canvas.width < w || canvas.height < h) { canvas.width = Math.max(canvas.width, w); canvas.height = Math.max(canvas.height, h); }
    return canvas;
  }
  // 클리핑 레이어의 기준(없으면 null, 잘라 그릴 그림 층 밖이면 undefined)
  function clipBaseOf(item) {
    const parent = item._parent;
    if (!parent || !clipLayers.has(parent)) return undefined;
    for (let i = item.index - 1; i >= 0; i--) {
      const below = parent._children[i];
      if (helperFast(below) || below._data?.evrClip) continue;
      return below;
    }
    return null;
  }
  // paper 항목 그리기(Item#draw, paper 0.12.15)를 감싼다: 클리핑 레이어는 자기 범위만 한 임시 캔버스에 자기와 기준을 그려 기준 모양
  // 안만 남긴 뒤(destination-in) 얹는다. paper는 불투명도·합성 모드가 있거나 획 굵기를 확대에 맞추지 않는 항목을 "장치 화소 =
  // (화면 좌표 − param.offset) × 화소 배율"로 그리므로, 임시 캔버스 원점을 param.offset으로 알린다. 기준이 숨었으면 클리핑 레이어도
  // 안 보인다(포토샵). 저장 PNG(엔트리가 그림 층을 굽기)도 이 그리기를 탄다.
  function hookClipDraw(P) {
    const proto = P?.Item?.prototype;
    if (!proto || own(proto, '__evrClipDraw') || typeof proto.draw !== 'function') return;
    Object.defineProperty(proto, '__evrClipDraw', { value: true });
    const draw = proto.draw;
    let warned = false;
    proto.draw = function (ctx, param, parentStrokeMatrix) {
      if (!this._data?.evrClip || clipDrawOff || !param || param.clip || !this._visible || !this._opacity) return draw.call(this, ctx, param, parentStrokeMatrix);
      const base = clipBaseOf(this);
      if (!base) return draw.call(this, ctx, param, parentStrokeMatrix);
      if (!base._visible || !base._opacity) return undefined;
      const offset = param.offset;
      try {
        const matrices = param.matrices, parentMatrix = matrices[matrices.length - 1];
        const g = param.pixelRatio || 1, ox = offset?.x || 0, oy = offset?.y || 0, canvas = ctx.canvas, m = ctx.getTransform();
        // 항목이 그려지는 장치 화소 범위(ctx 기준, 캔버스 안)
        const deviceRect = item => {
          const global = parentMatrix.appended(item._matrix);
          const box = item.getStrokeBounds(param.viewMatrix ? param.viewMatrix.appended(global) : global);
          const x0 = Math.max(0, Math.floor((box.x - ox) * g) - 2), y0 = Math.max(0, Math.floor((box.y - oy) * g) - 2);
          const x1 = Math.min(canvas.width, Math.ceil((box.x + box.width - ox) * g) + 2), y1 = Math.min(canvas.height, Math.ceil((box.y + box.height - oy) * g) + 2);
          return x1 > x0 && y1 > y0 ? { x0, y0, w: x1 - x0, h: y1 - y0 } : null;
        };
        const rect = deviceRect(this);
        if (!rect) return undefined;
        const paint = (index, item, r) => {
          const target = clipScratchCanvas(index, r.w, r.h), c = target.getContext('2d');
          c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
          c.clearRect(0, 0, r.w, r.h);
          c.save();
          c.beginPath(); c.rect(0, 0, r.w, r.h); c.clip();
          c.setTransform(m.a, m.b, m.c, m.d, m.e - r.x0, m.f - r.y0);
          param.offset = new P.Point(ox + r.x0 / g, oy + r.y0 / g);
          try { draw.call(item, c, param, item === this ? parentStrokeMatrix : undefined); }
          finally { param.offset = offset; c.restore(); }
          return target;
        };
        // 기준 모양은 한 번 그릴 때(같은 그리기 차례·같은 캔버스·같은 변환) 위로 이어진 클리핑 레이어들이 같이 쓴다 — 레이어마다 다시
        // 그리면 큰 기준(도형 1000개)에 클리핑 10개가 36ms 걸렸다(그냥은 3.6ms, 실측)
        const key = `${this._project?._updateVersion}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${ox},${oy},${g}`;
        if (clipMaskCache.base !== base || clipMaskCache.param !== param || clipMaskCache.key !== key || clipMaskCache.canvas !== canvas) {
          let union = null;
          const siblings = this._parent._children;
          for (let i = base.index + 1; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (helperFast(sibling)) continue;
            if (!sibling._data?.evrClip) break;
            const r = sibling._visible && sibling._opacity ? deviceRect(sibling) : null;
            if (!r) continue;
            if (!union) union = { ...r };
            else {
              const x1 = Math.max(union.x0 + union.w, r.x0 + r.w), y1 = Math.max(union.y0 + union.h, r.y0 + r.h);
              union.x0 = Math.min(union.x0, r.x0); union.y0 = Math.min(union.y0, r.y0); union.w = x1 - union.x0; union.h = y1 - union.y0;
            }
          }
          union ||= rect;
          paint(1, base, union);
          Object.assign(clipMaskCache, { base, param, key, canvas, rect: union });
        }
        const layer = paint(0, this, rect), lc = layer.getContext('2d'), mr = clipMaskCache.rect;
        lc.globalCompositeOperation = 'destination-in';
        lc.drawImage(clipScratch[1], rect.x0 - mr.x0, rect.y0 - mr.y0, rect.w, rect.h, 0, 0, rect.w, rect.h);
        lc.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(layer, 0, 0, rect.w, rect.h, rect.x0, rect.y0, rect.w, rect.h);
        ctx.restore();
        return undefined;
      } catch (error) {
        param.offset = offset;
        if (!warned) { warned = true; console.warn('[entry-vector-rig] 클리핑 그리기 실패 — 자르지 않고 그림', error); }
        return draw.call(this, ctx, param, parentStrokeMatrix);
      }
    };
  }
  // 옛 묶음 찾기: 다시 열면 엔트리가 묶음을 다른 묶음 하나로 싸서 넣을 수 있어(벡터 클리핑 마스크 실험) 항목 하나뿐인 묶음은 안으로 따라간다
  function clipStackOf(item) {
    for (let node = item; node?.className === 'Group'; node = node.children.length === 1 ? node.firstChild : null) {
      if (node.data?.[CLIP_STACK]) return node;
      // 다시 짜면 감싼 묶음은 빠지므로 숨김·불투명도·합성 모드·이름이 없는 것만 따라간다
      if (node.opacity !== 1 || !node.visible || node.blendMode !== 'normal' || node.data?.evrName || node.name) return null;
    }
    return null;
  }
  // 레이어 줄(아래부터): { item, clip, unit(그림 층 맨 위 항목), index, name }. 클리핑은 아래에 기준 레이어가 있을 때만.
  function vectorRows(layer) {
    const rows = [];
    let base = false;
    for (const unit of layer?.children || []) {
      if (isLayerHelper(unit)) continue;
      const stack = clipStackOf(unit); // 아직 풀지 않은 옛 묶음
      if (stack) { stack.children.forEach((item, index) => rows.push({ item, clip: index > 0, unit })); base = true; continue; }
      const flagged = !!unit.data?.evrClip;
      rows.push({ item: unit, clip: flagged && base, unit });
      if (!flagged) base = true;
    }
    rows.forEach((row, index) => {
      row.index = index;
      row.name = row.item.data?.evrName || row.item.name || `${isRasterLayer(row.item) ? '그림' : '레이어'} ${index + 1}`;
    });
    return rows;
  }
  // paper는 숫자로만 된 이름을 받지 않는다 — 그때는 data에만 둔다
  const paperNameOk = name => name !== String(+name);
  function setItemName(item, name) {
    item.data.evrName = name;
    item.name = paperNameOk(name) ? name : null;
  }
  // 클리핑 표시를 건다·뗀다. 예전 방식(묶음 안 source-atop)이 남긴 합성 모드는 지운다(합친 묶음 안은 vectorLayerAction·normalize가 다시 건다).
  function setClipBlend(item, on) {
    if (on) item.data.evrClip = true;
    else if (item.data?.evrClip) delete item.data.evrClip;
    if (item.blendMode === 'source-atop') item.blendMode = 'normal';
  }
  // 줄 목록(아래부터 { item, clip })대로 그림 층을 다시 짠다: 줄마다 그림 층 맨 위 항목 하나(묶지 않음), 아래에 기준이 없으면 클리핑 아님.
  // 목록에 없는 항목(지운 줄)과 옛 묶음은 빠진다. 기준점 상자는 그 자리에 둔다.
  function restackVector(layer, P, rows) {
    rows.forEach(row => row.item.remove());
    for (const child of [...layer.children]) if (!isLayerHelper(child)) child.remove();
    try {
      let base = false;
      for (const row of rows) {
        const clip = !!row.clip && base;
        setClipBlend(row.item, clip);
        if (!clip) base = true;
        layer.addChild(row.item);
      }
    } finally {
      // 중간에 멈춰도 떼어 낸 항목은 그림 층에 남긴다(지워지지 않게)
      for (const row of rows) if (!row.item.isInserted()) layer.addChild(row.item);
    }
  }
  // 고른 줄: 엔트리 선택(맨 위 항목)에 든 줄들, 그중 창에서 누른 줄(같은 묶음 안이면) 아니면 맨 위
  function vectorPicked(ep, rows) {
    const picked = new Set(selectedPaintItems(ep));
    return rows.filter(row => picked.has(row.item) || picked.has(row.unit));
  }
  // 레이어 창에서 누른 줄 기록(layerUi.vectorPick)은 엔트리 선택이 다른 것으로 바뀌면 지운다 — 남아 있으면 그림판에서 딴 것을 골랐다 푼 뒤에도
  // [필터] 설명이 "숨긴 레이어"로 나왔다(검토 M·N, 시험 재현). 창 다시 그리기(0.5초 점검·창 열림)는 그 사이 선택을 못 보므로 엔트리 store가
  // 바뀔 때마다 보되, 선택 목록이 실제로 바뀐 때만 본다(줄을 누르면 도구 바꾸기가 먼저 올 수 있음). 누르면 store에 그 줄의 맨 위 항목이 바로
  // 들어오므로(data.selected는 늦을 수 있음) 그때는 지우지 않는다.
  const pickWatched = new WeakSet();
  function watchVectorPick() {
    const store = paintStore();
    if (!store || pickWatched.has(store) || typeof store.subscribe !== 'function') return;
    pickWatched.add(store);
    let last = store.getState().paint?.selectedItems;
    store.subscribe(() => {
      try { // 구독 함수 예외는 엔트리 dispatch를 부른 쪽으로 번진다(redux) — 여기서 막는다(검토 O)
        const picked = store.getState().paint?.selectedItems;
        if (picked === last) return;
        last = picked;
        const pick = layerUi.vectorPick;
        if (!pick || !picked?.length) return;
        if (!picked.some(item => item === pick || pick.isDescendant?.(item) || item?.isDescendant?.(pick))) layerUi.vectorPick = null;
      } catch (error) { console.warn('[entry-vector-rig] 레이어 창 고른 줄', error); }
    });
  }
  function vectorPrimary(ep, rows) {
    const on = vectorPicked(ep, rows);
    return on.find(row => row.item === layerUi.vectorPick) || on[on.length - 1] || null;
  }
  // 엔트리 선택 도구로 그 줄의 맨 위 항목을 고른다(엔트리는 맨 위 항목 단위로 고름)
  function selectVectorUnit(item) {
    const store = paintStore();
    if (!store || !item?.parent) return;
    let unit = item;
    while (unit.parent && unit.parent.className !== 'Layer') unit = unit.parent;
    if (store.getState().tool.toolMode !== 'SELECT') store.dispatch({ type: 'CHANGE_TOOL_MODE', payload: 'SELECT' });
    store.dispatch({ type: 'SELECT_ITEMS', payload: [unit] });
  }
  function saveVectorLayers(ep) {
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 벡터 레이어: 되돌리기 기록을 남기지 못함');
    renderLayerPanel(ep, null);
  }
  function setVectorProp(ep, item, key, value, commit = true) {
    if (key === 'name') setItemName(item, value);
    else if (item[key] !== value) item[key] = value;
    if (commit) saveVectorLayers(ep);
    else renderLayerPanel(ep, null);
  }
  // 창 단추: 복제·앞으로·뒤로·삭제·클리핑·아래로 합치기(비트맵 레이어와 같은 규칙)
  function vectorLayerAction(ep, kind) {
    const layer = paintLayer(ep)?.layer;
    const rows = vectorRows(layer), row = vectorPrimary(ep, rows);
    if (!row) return;
    const list = rows.map(r => ({ item: r.item, clip: r.clip })), at = row.index;
    let target = row.item;
    if (kind === 'up' || kind === 'down') {
      const to = at + (kind === 'up' ? 1 : -1);
      if (to < 0 || to >= list.length) return;
      [list[at], list[to]] = [list[to], list[at]];
    } else if (kind === 'dup') {
      target = row.item.clone({ insert: false });
      // paper 복제는 data를 통째로 복사한다(entry-paint 260921 copyAttributes) — 원본의 엔트리 선택 표시·윤곽선 참조는 지운다
      for (const item of [target, ...target.getItems({})]) { delete item.data.selected; delete item.data.guideItem; }
      setItemName(target, `${row.name} 복사`);
      list.splice(at + 1, 0, { item: target, clip: row.clip });
    } else if (kind === 'del') {
      if (list.length < 2) return;
      list.splice(at, 1);
      target = list[Math.max(0, at - 1)].item;
    } else if (kind === 'clip') {
      if (at === 0) return;
      list[at].clip = !list[at].clip;
    } else if (kind === 'merge') {
      if (at === 0) return;
      const below = list[at - 1], top = list[at], group = new ep.paper.Group({ insert: false });
      setItemName(group, rows[at - 1].name);
      group.visible = below.item.visible;
      below.item.visible = true;
      below.item.remove();
      top.item.remove();
      setClipBlend(below.item, false);
      group.addChild(below.item);
      // 숨긴 위 레이어는 비트맵 합치기처럼 버린다. 기준에 잘려 있던 위 레이어는 합친 묶음 안에서도 아래에만 잘린다.
      if (top.item.visible) {
        const inside = top.clip && !below.clip;
        group.addChild(top.item);
        setClipBlend(top.item, inside);
        // 합친 묶음은 한 레이어라 그 안의 자르기는 묶음 안 합성으로(따로 합성하는 묶음 + source-atop)
        if (inside) { group.data.evrIsolate = true; group.opacity = CLIP_ISOLATE; top.item.blendMode = 'source-atop'; }
      }
      list.splice(at - 1, 2, { item: group, clip: below.clip });
      target = group;
    } else return;
    paintStore()?.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    restackVector(layer, ep.paper, list);
    layerUi.vectorPick = target;
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 벡터 레이어: 되돌리기 기록을 남기지 못함');
    selectVectorUnit(target);
    renderLayerPanel(ep, null);
  }
  // 벡터 레이어를 끌어 놓은 자리로(줄 목록 아래부터 번호): 앞으로·뒤로 단추와 같은 길(그림 층 다시 짜기 + 엔트리 되돌리기 기록 한 번)
  function vectorMoveTo(ep, id, to) {
    const layer = paintLayer(ep)?.layer;
    const rows = vectorRows(layer), from = rows.findIndex(row => String(row.item.id) === id);
    if (from < 0 || to < 0 || to >= rows.length || from === to) return;
    const list = rows.map(row => ({ item: row.item, clip: row.clip }));
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    paintStore()?.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    restackVector(layer, ep.paper, list);
    layerUi.vectorPick = moved.item;
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 벡터 레이어: 되돌리기 기록을 남기지 못함');
    selectVectorUnit(moved.item);
    renderLayerPanel(ep, null);
  }
  // 다시 열었을 때(SVG에는 합성 모드가 안 남음) 맞추기: 잘라 그릴 그림 층으로 두고, 옛 클리핑 묶음(evrClipStack — 예전 저장 SVG)은 풀어
  // 맨 위 항목으로 옮긴다(첫 항목 = 기준, 나머지 = 클리핑 레이어, 감싼 묶음의 변환은 항목에). 이름은 data 값으로 되돌린다.
  function normalizeVectorLayers(ep) {
    const layer = ep?.mode === 'VECTOR' && !session && paintLayer(ep)?.layer;
    if (!layer) return;
    hookClipDraw(ep.paper);
    clipLayers.add(layer);
    for (const unit of [...layer.children]) {
      if (isLayerHelper(unit)) continue;
      const stack = clipStackOf(unit);
      if (!stack) continue;
      const toLayer = layer.globalMatrix.inverted().appended(stack.globalMatrix);
      const members = [...stack.children], at = unit.index;
      members.forEach((item, index) => { item.remove(); item.transform(toLayer); setClipBlend(item, index > 0); });
      unit.remove();
      layer.insertChildren(at, members);
    }
    for (const unit of layer.children) if (unit.data?.evrClip && unit.blendMode === 'source-atop') unit.blendMode = 'normal';
    for (const group of layer.getItems({ match: item => item.data?.evrIsolate })) {
      if (group.opacity === 1) group.opacity = CLIP_ISOLATE;
      for (const item of group.children) if (item.data?.evrClip && item.blendMode !== 'source-atop') item.blendMode = 'source-atop';
    }
    for (const { item } of vectorRows(layer)) {
      const name = item.data?.evrName;
      if (name && item.name !== name && paperNameOk(name)) item.name = name;
    }
  }
  // 작은 그림(숨기거나 잘린 레이어도 내용이 보이게). 엔트리 기록(SNAPSHOT_SAVED)마다 다시 그린다.
  // lazy: 새로 구워야 하면 빈 칸을 주고(dataset.pending) 목록에서 보이는 줄만 fillVisibleThumbs가 굽는다 — 도형 1,000개에서
  // 고칠 때마다 전부 구우면 0.84초 멈췄다(실측)
  function vectorThumb(ep, item, lazy = false) {
    const cached = layerUi.thumbs.get(item);
    if (cached?.epoch === layerUi.vectorEpoch) return cached.canvas;
    if (lazy) {
      const blank = canvasOfSize(40, 24);
      blank.dataset.pending = '1';
      return blank;
    }
    const thumb = canvasOfSize(40, 24), stage = paintLayer(ep)?.stage;
    if (stage && item.bounds.width && item.bounds.height) {
      const k = Math.min(40 / stage.width, 24 / stage.height);
      const keep = { visible: item.visible, opacity: item.opacity, blendMode: item.blendMode };
      item.visible = true; item.opacity = 1; item.blendMode = 'normal';
      clipDrawOff++; // 잘린 레이어도 내용 그대로
      try {
        const raster = item.rasterize({ resolution: 72 * k * 2, insert: false }), b = raster.bounds;
        if (raster.width && raster.height) thumb.getContext('2d').drawImage(raster.canvas, (b.x - stage.x) * k + (40 - stage.width * k) / 2,
          (b.y - stage.y) * k + (24 - stage.height * k) / 2, b.width * k, b.height * k);
      } catch (error) { console.warn('[entry-vector-rig] 레이어 작은 그림', error); }
      finally { clipDrawOff--; Object.assign(item, keep); }
    }
    layerUi.thumbs.set(item, { epoch: layerUi.vectorEpoch, canvas: thumb });
    return thumb;
  }
  // ---- 모드를 바꿔도 레이어 유지 ----
  // 엔트리(entry-paint 260921)는 모드 버튼 → 저장소 모드 바꿈 → 관찰자가 선택 비우기(SELECT_ITEMS) → 변환 → 기록 순서로 돈다.
  // 선택 비우기 때는 저장소 모드만 새 모드고 그림판 모드(ep.mode)는 아직 옛 모드라 사용자가 모드를 바꾼 것을 안다(되돌리기는 그림판
  // 모드를 먼저 바꿔 둘이 같다 — 실험). 엔트리 변환은 그대로 태우고 한가운데만 바꾼다:
  // - 벡터 → 비트맵: 엔트리는 맨 위 항목마다 따로 굽고(경로는 번짐 없이, 묶음·그림은 그대로 — 실험: 엔트리봇 16조각 + 도형) 무대 크기
  //   빈 그림과 함께 그림 층에 넣은 뒤 통째로 굽는다. 그 굽기(rasterize) 직전 조각을 레이어마다 남기고, 합친 그림 대신 지금 레이어를 돌려준다.
  //   클리핑 묶음은 미리 풀고, 숨김·불투명도·합성 모드는 레이어 속성으로 옮겨 내용만 굽게 한다(엔트리 그대로면 숨긴 도형은 사라지고
  //   경로 불투명도는 빠짐 — 실험).
  // - 비트맵 → 벡터: 엔트리는 지금 그림 한 장을 칠해진 범위로 잘라 그림(Raster) 하나로 둔다. 그림 층을 비우는 순간 레이어마다 칠해진
  //   범위로 자른 그림 항목(이름·숨김·불투명도·클리핑)을 넣고 엔트리가 넣는 한 장은 버린다. 빈 레이어는 벡터 항목이 없어 빠진다.
  // 두 경우 모두 엔트리 기록이 바뀐 결과로 남아 되돌리면 옛 모드·레이어로 돌아간다.
  function beginLayerConvert(ep, from, to) {
    const layer = paintLayer(ep)?.layer;
    layerUi.convert = null;
    if (!layer) return;
    const disarm = () => setTimeout(() => { if (layerUi.convert?.layer === layer) layerUi.convert = null; }, 0);
    if (from === 'VECTOR' && to === 'BITMAP') {
      const rows = vectorRows(layer);
      // 벡터 레이어(맨 위 항목) 하나 = 비트맵 레이어 하나. 합치지 않는다(사용자 요청 10-18 "백터에서 비트맵으로 변환할 때 레이어 하나로
      // 합치지 마" — 1.3.0 전에는 레이어 창에서 손대지 않은 줄이 이어지면 한 장으로 합쳤음). 엔트리봇(맨 위 묶음 16개)이면 비트맵 레이어
      // 16개가 된다. 줄이 하나뿐이고 손대지 않았으면 엔트리 변환 그대로(결과도 한 장).
      const touched = row => row.item !== row.unit || row.clip || !!row.item.data?.evrName || !!row.item.data?.evrAlphaLock ||
        !row.item.visible || row.item.opacity !== 1;
      if (!rows.length || rows.length < 2 && !touched(rows[0])) return;
      const pickedRow = vectorPrimary(ep, rows);
      const keep = rows.map(row => ({ name: row.name, visible: row.item.visible, opacity: row.item.opacity, clip: row.clip, lock: !!row.item.data?.evrAlphaLock }));
      for (const child of [...layer.children]) if (isLayerHelper(child)) child.remove();
      rows.forEach(row => row.item.remove());
      layer.removeChildren();
      for (const row of rows) {
        row.item.visible = true;
        row.item.opacity = 1;
        setClipBlend(row.item, false);
        layer.addChild(row.item);
      }
      layerUi.convert = { to, layer, rows: keep, active: pickedRow ? rows.indexOf(pickedRow) : keep.length - 1 };
      disarm();
    } else if (from === 'BITMAP' && to === 'VECTOR') {
      const meta = storedLayerMeta(layer);
      if (!meta || !layersMatter(meta) || !layer.children.some(isRasterLayer)) return;
      storeActive(ep, meta);
      const items = [];
      for (const row of meta.layers) {
        const content = trimContent(layerContent(ep, meta, row));
        if (!content) continue;
        const raster = new ep.paper.Raster({ canvas: content.canvas, insert: false });
        raster.position = new ep.paper.Point(content.x + content.canvas.width / 2, content.y + content.canvas.height / 2);
        setItemName(raster, row.name);
        raster.visible = row.visible;
        raster.opacity = row.opacity;
        if (row.lock) raster.data.evrAlphaLock = true;
        items.push({ item: raster, clip: row.clip });
      }
      if (!items.length) return;
      layerUi.convert = { to, layer, items };
      disarm();
    }
  }
  // 내용 { canvas, x, y }의 칠해진(알파 > 0) 범위만 잘라 낸 사본
  function trimContent(content) {
    const canvas = content?.canvas, w = canvas?.width, h = canvas?.height;
    if (!w || !h) return null;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let left = w, top = h, right = -1, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!data[(y * w + x) * 4 + 3]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
    if (right < 0) return null;
    const out = canvasOfSize(right - left + 1, bottom - top + 1);
    out.getContext('2d').drawImage(canvas, -left, -top);
    return { canvas: out, x: content.x + left, y: content.y + top };
  }
  function finishToBitmap(ep, layer, convert) {
    const pieces = layer.children.slice(1);
    if (!isRasterLayer(layer.children[0]) || pieces.length !== convert.rows.length || !pieces.every(isRasterLayer)) return null;
    const meta = { v: 1, active: null, layers: [] };
    convert.rows.forEach((row, index) => {
      // 조각 하나 = 레이어 하나(조각은 정수 자리 — paper rasterize)
      const piece = pieces[index];
      const item = { id: layerUid('L'), name: row.name, visible: row.visible, opacity: row.opacity, clip: !!row.clip && index > 0, lock: row.lock, ref: null };
      if (piece.width && piece.height) {
        const b = piece.bounds, ref = layerUid('r');
        layerCache.set(ref, { canvas: rasterCopy(piece), x: Math.round(b.x), y: Math.round(b.y) });
        item.ref = ref;
      }
      meta.layers.push(item);
    });
    meta.active = (meta.layers[convert.active] || meta.layers[meta.layers.length - 1]).id;
    layer.data[LAYERS] = meta;
    layerUi.signature = null;
    pixelPen.alphaLock = !!activeLayer(meta).lock;
    return layerRaster(ep, activeLayer(meta));
  }
  function keepConvertLook(layer, convert) {
    const pieces = layer.children.slice(1);
    if (pieces.length !== convert.rows.length) return;
    pieces.forEach((piece, index) => { piece.visible = convert.rows[index].visible; piece.opacity = convert.rows[index].opacity; });
  }
  function finishToVector(ep, layer, convert) {
    delete layer.data[LAYERS];
    clearLayerDisplays(ep);
    restackVector(layer, ep.paper, convert.items);
    layerUi.signature = null;
    layerUi.convert = { dropAdd: true, layer };
    setTimeout(() => { if (layerUi.convert?.layer === layer) layerUi.convert = null; }, 0);
  }
  function hookModeSwitch() {
    const store = paintStore();
    if (!store || own(store, '__evrModeHook')) return;
    Object.defineProperty(store, '__evrModeHook', { value: true });
    const dispatch = store.dispatch;
    store.dispatch = function (action, ...rest) {
      if (action?.type === 'SELECT_ITEMS') {
        try {
          const ep = window.Entry?.playground?.painter?.entryPaint, to = store.getState().tool.graphicsMode, from = ep?.mode;
          if (ep && from !== to && (to === 'BITMAP' || to === 'VECTOR')) beginLayerConvert(ep, from, to);
        } catch (error) {
          layerUi.convert = null;
          console.warn('[entry-vector-rig] 레이어 유지(모드 바꾸기) 준비 실패', error);
        }
      }
      return dispatch.call(this, action, ...rest);
    };
  }
  // ---- 레이어 저장·열기 ----
  // 저장하는 동안만 그림 층에 합친 그림을 넣는다(엔트리 크기·중심·PNG 처리를 그대로). 끝나면 지금 레이어 그림으로 돌린다.
  function beginLayerSave(ep) {
    const meta = layerMeta(ep);
    if (!meta || !layersMatter(meta)) return null;
    storeActive(ep, meta);
    const merged = composeLayers(ep, meta);
    const parts = paintLayer(ep);
    const kept = parts.layer.removeChildren() || [];
    if (merged) {
      const raster = new ep.paper.Raster({ canvas: merged.canvas, insert: false });
      raster.position = new ep.paper.Point(merged.x + merged.canvas.width / 2, merged.y + merged.canvas.height / 2);
      parts.layer.addChild(raster);
    }
    const contents = new Map(meta.layers.map(layer => [layer.id, layerContent(ep, meta, layer)]));
    return { ep, layer: parts.layer, kept, meta: JSON.parse(JSON.stringify(meta)), contents, home: areaHome(ep) };
  }
  function endLayerSave(swap) {
    if (!swap) return;
    swap.layer.removeChildren();
    swap.kept.forEach(item => swap.layer.addChild(item));
  }
  // 보이는 것은 엔트리가 만든 합친 PNG 한 장, 레이어 원본은 <metadata>에 PSD(ag-psd)로(확장 없는 편집기·서버 변환은 보이는 그림만 씀).
  // PSD에 레이어 순서(아래부터)·이름·숨김·불투명도·클리핑·투명 잠금·그림·위치가 들어간다. PSD 문서는 모든 레이어를 덮는 틀이고,
  // 그 왼쪽 위가 십자에서 떨어진 거리(x, y)와 지금 레이어 번호(active)는 PSD 옆 JSON에 둔다.
  const bytesToBase64 = bytes => {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const base64ToBytes = text => typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(text)
    : Uint8Array.from(atob(text.replace(/\s+/g, '')), ch => ch.charCodeAt(0));
  // 보이는 PNG(+픽셀 아트 SVG)를 새로 올릴 때 그 모양의 레이어 원본을 같이 담는다. 레이어 자리는 십자 기준이라 그림이 십자 기준으로
  // (dx, dy) 옮겨졌으면 같이 옮긴다. 원본을 못 받으면 던진다(합친 그림만 올려 레이어를 잃지 않게 — 부른 쪽은 그 모양을 건너뜀).
  async function withLayerOriginal(picture, payload, shift = { x: 0, y: 0 }) {
    const carried = picture.dimension?.[LAYER_ENT];
    const response = picture.filename ? await fetch(svgFile(picture.filename), { credentials: 'same-origin' }) : null;
    // 404: 서버에 레이어 원본이 없다(1.2.0 공통 크기 맞추기가 합친 PNG만 올려 표시만 남은 모양) — 부른 쪽이 보통 그림으로 다룬다(missing)
    if (!response?.ok && !carried) throw Object.assign(Error(`레이어 원본을 받을 수 없습니다 (${response?.status ?? '파일 없음'})`),
      { missing: !response || response.status === 404 });
    const text = response?.ok ? await response.text() : entLayerSvgText(carried);
    const node = new DOMParser().parseFromString(text, 'image/svg+xml');
    const meta = node.getElementById(LAYER_SVG) || node.querySelector(`metadata#${LAYER_SVG}`);
    const list = meta && JSON.parse(meta.textContent);
    if (!list || list.v !== 2 || list.format !== 'psd' || typeof list.psd !== 'string') throw Error('레이어 원본 형식이 다릅니다');
    list.x = clean(Number(list.x || 0) + shift.x);
    list.y = clean(Number(list.y || 0) + shift.y);
    // 레이어 관절도 십자 기준이라 그림과 같이 옮긴다
    if (Array.isArray(list.bones)) list.bones = list.bones.map(record => Array.isArray(record?.joints) ? { joints: record.joints.map(j =>
      ({ ...j, x: clean(Number(j.x) + shift.x), y: clean(Number(j.y) + shift.y) })) } : null);
    const extra = `<metadata id="${LAYER_SVG}">${JSON.stringify(list)}</metadata>`;
    if (payload.svg) return { ...payload, ext: 'svg', svg: payload.svg.replace(/<svg\b[^>]*>/, open => open + extra) };
    const { width, height } = payload.size;
    return { ...payload, ext: 'svg', imageType: 'png',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" ` +
        `viewBox="0 0 ${width} ${height}">${extra}<image width="${width}" height="${height}" xlink:href="${payload.image}"/></svg>` };
  }
  // 레이어 관절 기록(십자 기준): 지금 자세 자리 — 레이어 그림도 휜 채 저장되므로 다시 열면 그 모양이 새 기준(모양 하나짜리 bitmapRigRecord와 같음)
  function layerJointsRecord(layer, home, content) {
    const kept = layerBonesOf(layer);
    let rig = null;
    try { rig = kept?.bones ? JSON.parse(kept.bones) : null; } catch { rig = null; }
    if (rig && content) rig = rigMovedTo(rig, contentSig(content));
    const points = rig && validRig(rig) && rig.joints.length > 1 ? jointPoints(rig) : null;
    const joints = points ? rig.joints.map(j => ({ id: j.id, parent: j.parent, x: points[j.id].x, y: points[j.id].y })) : kept?.joints;
    if (!Array.isArray(joints) || joints.length < 2) return null;
    return { joints: joints.map(j => ({ id: j.id, parent: j.parent, x: clean(j.x - home.x), y: clean(j.y - home.y) })) };
  }
  // 파일의 레이어 관절 기록 → 편집기 좌표 관절(틀렸으면 null)
  function layerJointsFrom(record, home) {
    if (!Array.isArray(record?.joints) || record.joints.length < 2) return null;
    const joints = record.joints.map(j => ({ id: j.id, parent: j.parent, x: clean(home.x + Number(j.x)), y: clean(home.y + Number(j.y)) }));
    return validRig({ joints, pose: {}, source: [], radius: 1 }) ? joints : null;
  }
  function layerSvg(swap, png, baseSvg) {
    const size = pngSize(png), lib = window.__evrAgPsd;
    if (!size) return null;
    if (!lib?.writePsdUint8Array) throw Error('ag-psd를 불러오지 못했습니다');
    const placed = swap.meta.layers.map(layer => ({ layer, content: swap.contents.get(layer.id) }));
    const drawn = placed.map(item => item.content).filter(Boolean);
    const left = drawn.length ? Math.min(...drawn.map(c => Math.round(c.x))) : Math.round(swap.home.x);
    const top = drawn.length ? Math.min(...drawn.map(c => Math.round(c.y))) : Math.round(swap.home.y);
    const right = Math.max(left + 1, ...drawn.map(c => Math.round(c.x) + c.canvas.width));
    const bottom = Math.max(top + 1, ...drawn.map(c => Math.round(c.y) + c.canvas.height));
    const children = placed.map(({ layer, content }) => ({
      name: layer.name, hidden: !layer.visible, opacity: layer.opacity, clipping: !!layer.clip, protected: { transparency: !!layer.lock },
      ...(content ? { canvas: content.canvas, left: Math.round(content.x) - left, top: Math.round(content.y) - top } : {}),
    }));
    const psd = lib.writePsdUint8Array({ width: right - left, height: bottom - top, children },
      { noBackground: true, trimImageData: true, compress: true });
    const active = swap.meta.layers.findIndex(layer => layer.id === swap.meta.active);
    const bones = swap.meta.layers.map(layer => layerJointsRecord(layer, swap.home, swap.contents.get(layer.id)));
    const list = JSON.stringify({ v: 2, format: 'psd', active, x: left - swap.home.x, y: top - swap.home.y,
      ...(bones.some(Boolean) ? { bones } : {}), psd: bytesToBase64(psd) });
    const extra = `<metadata id="${LAYER_SVG}">${list}</metadata>`;
    // 픽셀 아트 모양은 그 SVG(보간 없는 그림)에 덧붙인다
    if (baseSvg) return baseSvg.replace(/<svg\b[^>]*>/, open => open + extra);
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}" ` +
      `viewBox="0 0 ${size.width} ${size.height}">${extra}<image width="${size.width}" height="${size.height}" xlink:href="${png}"/></svg>`;
  }
  // 레이어 SVG를 읽어 { meta, frame(엔트리에 넘길 지금 레이어 PNG — 가운데가 십자) } — 레이어 그림은 사본으로 남긴다
  function readLayerSvg(text, ep, pictureRig) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const node = doc.getElementById(LAYER_SVG) || doc.querySelector(`metadata#${LAYER_SVG}`);
    if (!node) return null;
    const list = JSON.parse(node.textContent);
    if (!list || list.v !== 2 || list.format !== 'psd' || typeof list.psd !== 'string') return null;
    const lib = window.__evrAgPsd;
    if (!lib?.readPsd) throw Error('ag-psd를 불러오지 못했습니다');
    const bytes = base64ToBytes(list.psd);
    const psd = lib.readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { skipCompositeImageData: true, skipThumbnail: true });
    // 확장이 쓴 PSD는 묶음(폴더) 없이 레이어만 — 묶음이 있으면 그 안은 건너뜀
    const items = (psd.children || []).filter(item => !item.children);
    if (!items.length) return null;
    const home = areaHome(ep), originX = home.x + Number(list.x || 0), originY = home.y + Number(list.y || 0);
    const meta = { v: 1, active: null, layers: [] };
    items.forEach((item, index) => {
      // PSD 불투명도는 1/255 단위 — 레이어 창은 1% 단위
      const layer = { id: layerUid('L'), name: String(item.name || '레이어').slice(0, 40), visible: !item.hidden,
        opacity: Math.round(Math.max(0, Math.min(1, Number(item.opacity ?? 1))) * 100) / 100, clip: !!item.clipping,
        lock: !!item.protected?.transparency, ref: null };
      if (item.canvas?.width && item.canvas.height) {
        const ref = layerUid('r');
        layerCache.set(ref, { canvas: item.canvas, x: originX + (item.left || 0), y: originY + (item.top || 0) });
        layer.ref = ref;
      }
      const joints = Array.isArray(list.bones) ? layerJointsFrom(list.bones[index], home) : null;
      if (joints) {
        const ref = layerUid('b');
        layerBones.set(ref, { bones: null, rest: null, joints });
        layer.bonesRef = ref;
      }
      meta.layers.push(layer);
    });
    meta.active = (meta.layers[list.active] || meta.layers[meta.layers.length - 1]).id;
    // 레이어별 관절이 없는 레이어 원본(1.3.0 저장)의 모양 하나짜리 관절은 그때처럼 지금 레이어 것이다 — 옮기지 않으면 안 보이고 다음 저장에 지워진다
    if (!Array.isArray(list.bones) && pictureRig) {
      let joints = null;
      try { joints = layerJointsFrom(JSON.parse(pictureRig), home); } catch { joints = null; }
      const active = meta.layers.find(layer => layer.id === meta.active);
      if (joints && !active.bonesRef) {
        const ref = layerUid('b');
        layerBones.set(ref, { bones: null, rest: null, joints });
        active.bonesRef = ref;
      }
    }
    // 엔트리는 연 그림을 가운데(십자)에 놓는다: 모든 레이어를 덮는, 십자 기준 대칭 틀에 지금 레이어를 그려 넘긴다
    const all = meta.layers.map(layer => layer.ref && layerCache.get(layer.ref)).filter(Boolean);
    const halfW = Math.max(1, ...all.map(c => Math.max(home.x - c.x, c.x + c.canvas.width - home.x)));
    const halfH = Math.max(1, ...all.map(c => Math.max(home.y - c.y, c.y + c.canvas.height - home.y)));
    const frame = canvasOfSize(Math.ceil(halfW) * 2, Math.ceil(halfH) * 2);
    const active = layerCache.get(meta.layers.find(layer => layer.id === meta.active).ref);
    if (active) frame.getContext('2d').drawImage(active.canvas, active.x - (home.x - Math.ceil(halfW)), active.y - (home.y - Math.ceil(halfH)));
    return { meta, frame };
  }
  // ---- .ent로 내려받기·불러오기 ----
  // 엔트리 .ent는 서버가 브라우저의 작품 JSON(Entry.exportProject — 모양 정보 dimension 통째)과 모양 파일을 묶는다(엔트리 웹사이트:
  // POST /rest/project/download {content, name}). 불러오기는 .ent를 서버에 올려(POST /rest/project/upload) 풀어 준 작품 JSON으로
  // 다시 연다. 실험(2026-10-14, 로그인 없이 8×8 시험 그림): 모양 정보 키는 그대로 남고, SVG 모양은 SVG도 묶여 벡터 뼈대(SVG 안
  // data-paper-data)도 남는다. 하지만 PNG 모양은 PNG만 묶여, 같은 이름의 SVG에 둔 비트맵 레이어 원본이 빠지고 불러오면 파일 이름도
  // 새로 바뀌어 레이어가 사라졌다. fileurl도 /uploads/ 주소는 빠진다 — 픽셀 아트 칸 주소는 restorePixelFileurls가 다시 걸지만, 파일
  // 이름 없는 라이브러리 그림은 그림 단서가 사라져 작품이 안 열렸다(ownPictureFile 설명).
  // 그래서 .ent로 내려받을 때만 레이어 원본(<metadata> 글)을 그 모양 정보(LAYER_ENT)에 담아 보내고, 불러온 작품에서 그 값을 보면
  // 레이어 SVG를 새 파일로 다시 올려 잇는다(올라가기 전에 열면 그 값에서 바로 연다). 평소 저장 작품 JSON에는 담지 않는다(크기).
  // 오브젝트 내보내기(POST /rest/object/download {content: {objects}, name})도 같은 모양 JSON이라 같이 고친다.
  const LAYER_ENT = 'entryVectorLayersEnt', ENT_FILE = 'entryVectorEntFile';
  // .ent 불러오기는 주소에 '/bower_components/'가 있어야 남기고 그 안의 './bower_components/'만 '/lib/'로 바꾼다. 작품 저장은
  // '/lib/../' 주소를 거절한다. 그래서 '..' 없이 서버가 무시하는 질의 글에 그 표시를 둔다.
  const ENT_KEEP = '?keep/bower_components/';
  // .ent에 담은 픽셀 모양 주소면 원래 /uploads/ 주소, 아니면 null. '/lib/..' 형태는 이 표시 전에 만든 .ent.
  function entKeptPath(url) {
    if (typeof url !== 'string') return null;
    if (url.startsWith('/lib/../uploads/')) return url.slice('/lib/..'.length);
    if (url.startsWith('/uploads/') && url.includes(ENT_KEEP)) return url.replace(ENT_KEEP, '');
    return null;
  }
  // .ent에 담았던 픽셀 모양이면 원래 파일 이름·주소로 되돌린다(주소가 빠졌어도 파일 이름은 — 파일 이름도 주소도 없으면 작품이 안 열림)
  function restoreEntPicture(picture) {
    const entFile = picture?.dimension?.[ENT_FILE];
    if (!entFile || picture.filename) return false;
    const kept = entKeptPath(picture.fileurl);
    if (!kept && picture.fileurl) return false;
    picture.filename = entFile;
    if (kept) picture.fileurl = kept;
    delete picture.dimension[ENT_FILE];
    return true;
  }
  // 엔트리 작품 열기(loadProject)를 거치지 않고 들어온 모양(확장이 늦게 붙은 첫 열기 등)도 자기 파일을 만들기 전에 되돌린다
  function restoreEntPictures() {
    if (entryLoading()) return;
    for (const object of window.Entry?.container?.getAllObjects?.() || []) for (const picture of object.pictures || []) restoreEntPicture(picture);
  }
  // 이 사이트의 /uploads/… 주소면 경로(+ #칸)만, 아니면 null
  function uploadsPath(url) {
    if (typeof url !== 'string') return null;
    if (url.startsWith('/uploads/')) return url;
    try { const u = new URL(url, location.href); return u.origin === location.origin && u.pathname.startsWith('/uploads/') ? u.pathname + u.hash : null; } catch { return null; }
  }
  const entLayerSvgText = meta => `<svg xmlns="${NS}"><metadata id="${LAYER_SVG}">${String(meta).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</metadata></svg>`;
  // 내려받기 요청 본문(작품 JSON 글)을 고친다. 실패하면 원래 본문 그대로.
  // - 아직 자기 파일이 없는 픽셀 모양(라이브러리 그림): 서버가 지울 칸 주소 대신 원래 라이브러리 주소(서버가 남김)를 보낸다.
  //   불러오면 확장이 칸 주소를 다시 건다. ownPixelPictures가 자기 파일을 만들기 전에 내려받는 경우의 안전망.
  // - 비트맵 레이어 모양: 레이어 원본을 모양 정보(LAYER_ENT)에 담는다.
  async function withEntLayers(body, url) {
    const data = JSON.parse(body), projectFile = /\/rest\/project\/download(\?|$)/.test(String(url));
    const all = (data?.content?.objects || []).flatMap(object => object?.sprite?.pictures || []).filter(Boolean);
    let changed = false;
    for (const picture of all) {
      const base = atlasOf(picture)?.base;
      if (!picture.filename && base && picture.fileurl !== base && /\/uploads\//.test(picture.fileurl || '')) {
        picture.fileurl = base;
        changed = true;
        continue;
      }
      // 1배 픽셀 모양은 실행 화면을 각지게 그리는 주소(/uploads/… SVG)로 그린다. .ent 만들기는 파일 이름이 있으면 주소를 덮어써서,
      // 파일 이름을 빼고 불러오기에 남는 표시(ENT_KEEP)를 붙여 담는다(확장 없이 열어도 각지고 저장됨). 원래 파일 이름은 모양 정보에 두어
      // 확장이 불러올 때 되돌린다(repairPictures). 작품 .ent만 — 오브젝트 불러오기는 서버 주소 규칙을 확인하지 않았다. 벡터 픽셀 모양은 빼는데,
      // 파일 이름(벡터 원본)을 빼면 확장 없는 그림판이 주소의 아틀라스 전체를 벡터로 연다.
      const path = projectFile && pixelOf(picture) === 1 && !pixelVector(picture) && uploadsPath(picture.fileurl);
      if (path && /\.svg(#|$)/.test(path)) {
        if (picture.filename) picture.dimension[ENT_FILE] = picture.filename;
        delete picture.filename;
        picture.fileurl = path.replace(/#|$/, mark => ENT_KEEP + mark);
        changed = true;
      }
    }
    const pictures = all.filter(picture => picture.dimension?.[LAYER_MARK] && picture.filename);
    await Promise.all(pictures.map(async picture => {
      try {
        const doc = new DOMParser().parseFromString(await svgText(svgFile(picture.filename)), 'image/svg+xml');
        const meta = doc.getElementById(LAYER_SVG)?.textContent;
        if (meta) { picture.dimension[LAYER_ENT] = meta; changed = true; }
      } catch (error) { console.warn('[entry-vector-rig] .ent에 레이어 담기 실패', picture.name, error); }
    }));
    return changed ? JSON.stringify(data) : body;
  }
  const isEntDownload = (method, url) => String(method).toUpperCase() === 'POST' && /\/rest\/(project|object)\/download(\?|$)/.test(String(url));
  // 이미 망가진 .ent(이전 버전에서 픽셀 아트를 켠 라이브러리 그림이 든 것): 파일 이름도 fileurl도 없는 모양이 있으면 엔트리가 작품 전체
  // 불러오기를 멈춘다. 엔트리가 작품을 읽기 직전(Entry.loadProject — 웹사이트 .ent 불러오기·작품 열기가 모두 이것을 부름)에 그 모양에
  // 원래 주소(모르면 아틀라스 칸)를 건다. 그다음 ownPixelPictures가 자기 파일을 만든다.
  function repairPictures(project) {
    let fixed = 0;
    for (const object of project?.objects || []) {
      for (const picture of object?.sprite?.pictures || []) {
        if (restoreEntPicture(picture)) { fixed++; continue; }
        if (!picture || picture.filename || picture.fileurl) continue;
        const atlas = atlasOf(picture);
        if (!atlas) continue;
        picture.fileurl = atlas.base || atlasUrl(atlas);
        fixed++;
      }
    }
    if (fixed) console.warn(`[entry-vector-rig] 그림 주소가 빠진 모양 ${fixed}개를 원래 주소로 이어 불러옵니다`);
  }
  // 다른 확장도 loadProject를 감쌀 수 있다. 맨 위가 우리 것인지만 보고 0.5초마다 다시 감싸면, 상대도 같은 식일 때 서로 끝없이 쌓여
  // 작품을 열 때마다 쌓인 수만큼 돈다(다른 확장과 함께 켠 크롬에서 '응답 없음' 기록). 엔트리마다 한 번만 감싸고(위에 누가 감싸도 우리 것은
  // 그 아래에서 그대로 불림), 엔트리가 아직 없을 때만 refresh에서 다시 시도한다.
  const loadRepairHooked = new WeakSet();
  function hookLoadRepair() {
    const E = window.Entry;
    if (typeof E?.loadProject !== 'function' || loadRepairHooked.has(E) || E.loadProject.__evrRepair) return;
    loadRepairHooked.add(E);
    const original = E.loadProject;
    const wrapped = function (project, ...rest) {
      try { repairPictures(project); } catch (error) { console.warn('[entry-vector-rig] 모양 주소 잇기', error); }
      return original.call(this, project, ...rest);
    };
    wrapped.__evrRepair = true;
    E.loadProject = wrapped;
  }
  // 엔트리 웹사이트는 내려받기를 axios(XMLHttpRequest)로 보낸다. 그 요청만 본문을 바꾸고 나머지는 그대로 보낸다.
  function hookEntDownload() {
    const proto = window.XMLHttpRequest?.prototype;
    if (proto && !own(proto, '__evrEntHook')) {
      Object.defineProperty(proto, '__evrEntHook', { value: true });
      const open = proto.open, send = proto.send;
      proto.open = function (method, url, ...rest) {
        this.__evrEnt = isEntDownload(method, url) ? String(url) : null;
        return open.call(this, method, url, ...rest);
      };
      proto.send = function (body) {
        if (!this.__evrEnt || typeof body !== 'string') return send.call(this, body);
        withEntLayers(body, this.__evrEnt).then(next => send.call(this, next), () => send.call(this, body));
        return undefined;
      };
    }
    // axios가 fetch로 보내는 경우까지
    const fetch0 = window.fetch;
    if (typeof fetch0 === 'function' && !fetch0.__evrEntHook) {
      const wrapped = function (input, init, ...rest) {
        const url = typeof input === 'string' ? input : input?.url;
        if (init && typeof init.body === 'string' && isEntDownload(init.method || 'GET', url))
          return withEntLayers(init.body, url).catch(() => init.body).then(body => fetch0.call(this, input, { ...init, body }, ...rest));
        return fetch0.call(this, input, init, ...rest);
      };
      wrapped.__evrEntHook = true;
      window.fetch = wrapped;
    }
  }
  // ---- 그림 임시저장(1.3, 사용자 요청 2명 + 사용자 결정) ----
  // 그림판에서 그리던 그림(지금 모양)을 서버에도 작품에도 넣지 않고 이 브라우저 안(IndexedDB)에 잠깐 저장했다가 다시 연다(사용자 "임시 저장은
  // 그림 임시저장", "말 그대로 임시" — 댓글 요청 "작품에는 바로 적용되지 않지만 오브젝트 창에서는 편집하고 저장"). 엔트리 그림판 [저장하기]
  // 펼침 메뉴(저장하기·새 모양으로 저장하기) 아래에 엔트리 항목과 같은 클래스로 [임시저장]과 이 모양의 임시저장 목록(모양마다 최근 5개)을
  // 붙인다(사용자 결정). 연 그림은 작품에 바로 들어가지 않고 엔트리 [저장하기]를 눌러야 들어간다.
  // 담는 것 = 엔트리 되돌리기 기록과 같은 그림 층 JSON(paper exportJSON — 자리·이름·확장 data 그대로) + 비트맵 레이어 그림(지금 레이어
  // 말고는 확장 메모리 layerCache에만 있어 PNG로 같이 담음). 여는 것 = 엔트리 되돌리기처럼 그림 층 importJSON(확장 레이어 목록도 같이
  // 돌아옴) 뒤 엔트리 되돌리기 기록 하나 — 되돌리면 연 직전(열 때 목록에 자동 기록을 남기지 않는다 — 사용자 "연 기록은 왜 뜨는 거야
  // 복잡하게", 5개 한도에서 직접 저장한 것을 밀어냈음). 벡터·비트맵이 다르면 열지 않는다
  // (그림 층 JSON이 모드마다 다름). 브라우저를 닫으면 지운다(/ws 경로 세션 쿠키가 없으면 새 브라우저 세션 → 모두 지움. 여러 탭은 쿠키를
  // 같이 써서 서로 지우지 않음. 크롬 "중단한 위치에서 계속하기"는 세션 쿠키를 되살려 남을 수 있음). 엔트리 자체 임시 보관(localStorageProject)과
  // 다른 칸이다. 목록(TEMP_STORE: id·작품 열쇠·모양 id·이름·모드·시각)과 내용(TEMP_DATA)을 따로 둔다 — 목록을 열 때 큰 그림을 다 읽지 않게.
  // 작품 열쇠는 페이지 주소(/ws/<번호>·/ws/new) + 모양 id. 1.3.0 개발판의 작품 전체 임시저장(머리 줄 단추)은 사용자 결정으로 뺐다.
  const TEMP_DB = 'entryVectorRig', TEMP_STORE = 'tempSaves', TEMP_DATA = 'tempData', TEMP_KEEP = 5, TEMP_COOKIE = 'evrTempSession';
  const TEMP_NO_COOKIE_MAX_AGE = 24 * 3600e3; // 쿠키를 못 쓰는 브라우저: 브라우저 닫힘을 알 수 없어 하루 지난 것만 지운다
  let tempDbPromise = null, tempSessionPromise = null, draftMenuHooked = false;
  function tempDb() {
    tempDbPromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(TEMP_DB, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TEMP_STORE)) db.createObjectStore(TEMP_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(TEMP_DATA)) db.createObjectStore(TEMP_DATA, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 확장을 업데이트한 뒤 다른 탭(옛 코드가 남아 있음)이 판을 올리려 하면 막지 않고 닫는다 — 다음에 다시 연다(검토 지적)
        db.onversionchange = () => { db.close(); tempDbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || Error('임시저장소를 열 수 없습니다.'));
    });
    tempDbPromise.catch(() => { tempDbPromise = null; });
    return tempDbPromise;
  }
  async function tempTx(mode, work) {
    const db = await tempDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([TEMP_STORE, TEMP_DATA], mode);
      let result;
      Promise.resolve(work(tx.objectStore(TEMP_STORE), tx.objectStore(TEMP_DATA))).then(value => { result = value; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || Error('임시저장소 오류'));
    });
  }
  const tempRequest = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  // 작품 열쇠: 저장한 작품 = 주소(/ws/<번호>). 저장 안 한 새 작품(/ws/new)은 엔트리 시작 작품의 모양 id가 늘 같아서(엔트리봇 'vx80' — 실측)
  // 새 작품끼리 임시저장이 섞이고 서로의 5개 정리에 지워졌다(검토 지적) — 탭마다 정한 표(sessionStorage: 같은 탭 새로고침이면 그대로)를
  // 붙인다. 처음 저장해 주소가 생기면 그 표의 임시저장을 새 주소로 옮기고 표를 새로 정한다(다음 새 작품과 섞이지 않게).
  const TEMP_TAB = 'evrTempTab';
  let tempTabFallback = null;
  function tempTab(renew) {
    const make = () => Math.random().toString(36).slice(2, 10);
    try {
      let tab = sessionStorage.getItem(TEMP_TAB);
      if (!tab || renew) { tab = make(); sessionStorage.setItem(TEMP_TAB, tab); }
      return tab;
    } catch { return (tempTabFallback = !tempTabFallback || renew ? make() : tempTabFallback); }
  }
  function tempProjectKey() {
    const path = location.pathname.replace(/\/+$/, '') || '/ws/new';
    return path === '/ws/new' ? `/ws/new#${tempTab(false)}` : path;
  }
  // 이 탭의 새 작품 임시저장을 처음 저장해 생긴 주소로 옮긴다(엔트리가 주소를 바꾸든 새로 열든 — 표는 탭에 남아 있음)
  async function moveNewProjectDrafts() {
    const key = tempProjectKey();
    if (key.startsWith('/ws/new')) return;
    let tab = null;
    try { tab = sessionStorage.getItem(TEMP_TAB); } catch { tab = tempTabFallback; }
    if (!tab) return;
    const from = `/ws/new#${tab}`;
    const moved = await tempTx('readwrite', async store => {
      let n = 0;
      for (const item of await tempRequest(store.getAll())) if (item.project === from) { item.project = key; store.put(item); n++; }
      return n;
    });
    if (moved) tempTab(true);
  }
  const hasTempCookie = () => document.cookie.split(';').some(part => part.trim().startsWith(`${TEMP_COOKIE}=`));
  // 새 브라우저 세션이면 모두 지운다(쿠키 없음 = 브라우저를 닫았다 다시 엶). 쿠키가 막힌 브라우저는 쿠키를 써도 안 보여 매번 "새 세션"이
  // 되므로(검토 지적) 다 지우지 않고 하루 지난 것만 지운다. 페이지마다 한 번 — 저장·목록은 이 지우기가 끝난 뒤에 한다(먼저 넣은 것이
  // 같이 지워지지 않게).
  function tempSessionCheck() {
    tempSessionPromise ||= (async () => {
      if (hasTempCookie()) return;
      document.cookie = `${TEMP_COOKIE}=1; path=/ws; SameSite=Lax`;
      const cookieWorks = hasTempCookie();
      try {
        await tempTx('readwrite', async (store, data) => {
          if (cookieWorks) { store.clear(); data.clear(); return; }
          for (const item of await tempRequest(store.getAll())) {
            if (Date.now() - item.savedAt > TEMP_NO_COOKIE_MAX_AGE) { store.delete(item.id); data.delete(item.id); }
          }
        });
      } catch (error) { console.warn('[entry-vector-rig] 임시저장 지우기', error); }
    })();
    return tempSessionPromise;
  }
  const tempTime = time => new Date(time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  function currentPicture(painter) {
    const id = painter?.file?.id;
    return id && window.Entry?.playground?.object?.pictures?.find(picture => picture.id === id) || null;
  }
  const isDraftOf = (item, picture) => item.kind === 'picture' && item.project === tempProjectKey() && item.picture === picture.id;
  async function draftList(painter) {
    await tempSessionCheck();
    await moveNewProjectDrafts();
    const picture = currentPicture(painter);
    if (!picture) return [];
    const all = await tempTx('readonly', store => tempRequest(store.getAll()));
    // 1.3.0 개발판의 '열기 전 자동' 기록은 보이지 않게(다음 임시저장 때 지움)
    return (all || []).filter(item => isDraftOf(item, picture) && !item.auto).sort((a, b) => b.savedAt - a.savedAt);
  }
  // 지금 그림판 그림 → 임시저장 내용(엔트리 되돌리기 기록과 같은 그림 층 JSON + 비트맵 레이어 그림)
  function draftPayload(ep) {
    const parts = paintLayer(ep);
    if (!parts) throw Error('그림판을 찾지 못했습니다.');
    const refs = {}, bones = {};
    const meta = ep.mode === 'BITMAP' ? storedLayerMeta(parts.layer) : null;
    for (const layer of meta?.layers || []) {
      // 지금 레이어 그림은 그림 층 JSON에 들어 있다(참조는 낡은 사본일 수 있어 담지 않음)
      const content = layer.id !== meta.active && layer.ref && layerCache.get(layer.ref);
      if (content) refs[layer.ref] = { x: content.x, y: content.y, png: content.canvas.toDataURL('image/png') };
      // 레이어 뼈대도 참조로만 레이어 정보에 있다(브라우저를 다시 열면 비어 있음)
      const kept = layerBonesOf(layer);
      if (kept) bones[layer.bonesRef] = kept;
    }
    return { v: 1, mode: ep.mode, json: parts.layer.exportJSON({ asString: true }), refs, bones };
  }
  async function draftSaveNow(painter) {
    await tempSessionCheck();
    await moveNewProjectDrafts();
    const ep = painter?.entryPaint, picture = currentPicture(painter);
    if (!ep || !picture) throw Error('그림판에 연 모양이 없습니다.');
    if (painter.__evrLoading) throw Error('모양 그림을 불러오는 중입니다. 그림이 보인 뒤 다시 하세요.');
    const payload = draftPayload(ep);
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: 'picture', project: tempProjectKey(), picture: picture.id,
      name: String(picture.name || ''), mode: ep.mode, savedAt: Date.now() };
    await tempTx('readwrite', async (store, data) => {
      store.put(item);
      data.put({ id: item.id, data: JSON.stringify(payload) });
      // 모양마다 최근 TEMP_KEEP개. 방금 넣은 것은 시계가 뒤로 가도 지우지 않는다. 예전 '열기 전 자동' 기록은 지운다
      const others = (await tempRequest(store.getAll())).filter(entry => isDraftOf(entry, picture) && entry.id !== item.id).sort((a, b) => b.savedAt - a.savedAt);
      const kept = others.filter(entry => !entry.auto);
      for (const old of [...others.filter(entry => entry.auto), ...kept.slice(TEMP_KEEP - 1)]) { store.delete(old.id); data.delete(old.id); }
    });
    return item;
  }
  async function draftOpen(painter, id) {
    const ep = painter?.entryPaint, picture = currentPicture(painter);
    const item = await tempTx('readonly', store => tempRequest(store.get(id)));
    const stored = item && await tempTx('readonly', (store, data) => tempRequest(data.get(id)));
    if (!item || !stored?.data) throw Error('그 임시저장을 찾을 수 없습니다(브라우저를 닫아 지워졌을 수 있습니다).');
    if (!ep || !picture || !isDraftOf(item, picture)) throw Error('지금 연 모양의 임시저장이 아닙니다.');
    if (painter.__evrLoading) throw Error('모양 그림을 불러오는 중입니다. 그림이 보인 뒤 다시 여세요.');
    if (session) throw Error('뼈대 모드를 끈 뒤 여세요.');
    const payload = JSON.parse(stored.data);
    if (payload.mode !== ep.mode) throw Error(`${payload.mode === 'BITMAP' ? '비트맵' : '벡터'}에서 임시저장한 그림입니다. 그 모드로 바꾼 뒤 여세요.`);
    // 비트맵 레이어 그림을 먼저 되살린다(그림 층 JSON의 레이어 목록이 이 참조를 씀 — 참조는 한 번 만들면 바뀌지 않음)
    for (const [ref, content] of Object.entries(payload.refs || {})) {
      if (!layerCache.has(ref)) layerCache.set(ref, { canvas: canvasOfImage(await loadImage(content.png)), x: content.x, y: content.y });
    }
    for (const [ref, kept] of Object.entries(payload.bones || {})) if (!layerBones.has(ref)) layerBones.set(ref, kept);
    if (painter.file?.id !== picture.id || ep.mode !== payload.mode) throw Error('그 사이 모양이나 모드가 바뀌어 열지 않았습니다.');
    paintStore()?.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    // 연 직전 상태를 되돌리기 기록에 남긴다 — 그림 전체 이동처럼 기록을 남기지 않는 변경도 되돌리기 한 번에 돌아오게(검토 지적)
    saveEntryHistory(ep);
    paintLayer(ep).layer.importJSON(payload.json);
    ep.project.view.update();
    saveEntryHistory(ep);
    painter.file.modified = true;
    return item;
  }
  // 엔트리 그림판 [저장하기]를 누르면 엔트리가 펼침 메뉴를 새로 그린다 — 몇 프레임 동안 찾아 확장 항목을 붙인다. 확장 항목은 누르기를
  // 엔트리로 보내지 않아(엔트리 항목으로 읽히지 않게) 메뉴가 열린 채라, 일을 마치면 [저장하기]를 한 번 더 눌러 닫는다(10-18 실험: 닫힘).
  function hookDraftMenu() {
    if (draftMenuHooked) return;
    draftMenuHooked = true;
    document.addEventListener('click', event => {
      if (!event.isTrusted) return; // 확장이 메뉴를 닫으려고 누른 것
      const save = event.target.closest?.('#entryPainter button');
      if (!save || save.textContent.trim() !== '저장하기') return;
      let tries = 0;
      const look = () => {
        const first = document.querySelector('[value="SAVE_PICTURE"]');
        if (first?.parentElement) addDraftItems(first.parentElement, first, save).catch(error => console.warn('[entry-vector-rig] 그림 임시저장 메뉴', error));
        else if (++tries < 20) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    }, true);
  }
  async function addDraftItems(inner, sample, save) {
    if (inner.querySelector('.evr-draft-item')) return;
    const painter = window.Entry?.playground?.painter;
    const close = () => { if (inner.isConnected && save.isConnected) save.click(); };
    const item = (text, cls, title) => {
      const element = document.createElement('div');
      element.className = `${sample.className} evr-draft-item ${cls}`;
      element.textContent = text;
      if (title) element.title = title;
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) element.addEventListener(type, event => event.stopPropagation());
      return element;
    };
    const run = async (work, done) => {
      close();
      try { toast(done(await work()), 4000); } catch (error) { toast(error.message || String(error), 5000); }
    };
    const now = item('임시저장', 'evr-draft-save', '확장: 이 모양 그림을 서버·작품에 넣지 않고 이 브라우저에 잠깐 저장(브라우저를 닫으면 지워짐, 모양마다 최근 5개)');
    now.addEventListener('click', () => run(() => draftSaveNow(painter),
      saved => `그림을 임시저장했습니다(${tempTime(saved.savedAt)}). 작품에는 [저장하기]를 눌러야 들어갑니다. 브라우저를 닫으면 지워집니다.`));
    // [임시저장]은 바로 붙이고 목록은 받은 뒤에(저장소가 늦거나 막혀도 저장은 되게 — 검토 지적)
    inner.append(now);
    const added = [];
    let drafts = [];
    try { drafts = await draftList(painter); } catch (error) { console.warn('[entry-vector-rig] 그림 임시저장 목록', error); }
    if (!inner.isConnected || inner.querySelector('.evr-draft-row')) return;
    const mode = painter?.entryPaint?.mode;
    for (const draft of drafts) {
      const other = draft.mode !== mode;
      const row = item(`임시저장 ${tempTime(draft.savedAt)} 열기`, 'evr-draft-row',
        other ? `${draft.mode === 'BITMAP' ? '비트맵' : '벡터'}에서 저장한 그림 — 그 모드로 바꾼 뒤 열 수 있습니다` : '이 임시저장을 그림판에 엽니다(되돌리기 한 번에 연 직전으로)');
      row.dataset.id = draft.id;
      if (other) row.dataset.off = 'true';
      const del = document.createElement('span');
      del.className = 'evr-draft-del';
      del.textContent = '×';
      del.title = '이 임시저장 지우기';
      row.append(del);
      row.addEventListener('click', event => {
        if (event.target === del) {
          run(() => tempTx('readwrite', (store, data) => { store.delete(draft.id); data.delete(draft.id); }), () => '임시저장 하나를 지웠습니다.');
          return;
        }
        run(() => draftOpen(painter, draft.id), opened => `${tempTime(opened.savedAt)}에 임시저장한 그림을 열었습니다. 작품에 넣으려면 [저장하기], 되돌리면 연 직전.`);
      });
      added.push(row);
    }
    inner.append(...added);
  }
  // .ent로 불러온 레이어 모양: 합친 PNG(새 파일)와 담겨 온 레이어 원본으로 레이어 SVG를 다시 올리고 모양을 그 파일로 바꾼다
  const entLayerJobs = new Set(), entLayerFailed = new Map(); // 모양 id → 실패한 때(30초 뒤 다시)
  function restoreEntLayers() {
    if (entryLoading()) return;
    for (const object of window.Entry?.container?.getAllObjects?.() || []) {
      for (const picture of object.pictures || []) {
        const meta = picture.dimension?.[LAYER_ENT];
        if (!meta || !picture.filename || entLayerJobs.has(picture.id) || Date.now() - (entLayerFailed.get(picture.id) || 0) < 30000) continue;
        entLayerJobs.add(picture.id);
        (async () => {
          const clean = (current, filename) => {
            const dimension = { ...current.dimension };
            delete dimension[LAYER_ENT];
            return { ...current, ...(filename ? { filename } : {}), dimension };
          };
          // 이 파일 이름의 레이어 SVG가 이미 있으면(같은 작품을 다시 연 경우) 담긴 값만 지운다
          const existing = await fetch(svgFile(picture.filename)).then(response => response.ok ? response.text() : '').catch(() => '');
          if (existing.includes(`id="${LAYER_SVG}"`)) { replacePictures(object, [picture], current => clean(current)); return; }
          const canvas = canvasOfImage(await loadImage(runtimePng(picture.filename)));
          const png = canvas.toDataURL('image/png'), width = canvas.width, height = canvas.height;
          const svg = `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
            `<metadata id="${LAYER_SVG}">${String(meta).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</metadata>` +
            `<image width="${width}" height="${height}" xlink:href="${png}"/></svg>`;
          const saved = await uploadPayload({ ext: 'svg', svg, image: png, size: { width, height } });
          replacePictures(object, [picture], current => clean(current, saved.filename));
        })().catch(error => { entLayerFailed.set(picture.id, Date.now()); console.warn('[entry-vector-rig] .ent 레이어 이어 주기 실패 — 30초 뒤 다시', picture.name, error); })
          .finally(() => entLayerJobs.delete(picture.id));
      }
    }
  }
  // ---- 레이어 창(비트맵 모드, 그림 칸 오른쪽 위에 접어 둠). 목록 위가 앞(포토샵·프로크리에이트와 같은 순서) ----
  function buildLayerPanel() {
    const panel = document.createElement('div');
    panel.className = 'evr-layers';
    const ep = () => window.Entry?.playground?.painter?.entryPaint;
    const vector = () => ep()?.mode === 'VECTOR';
    // 벡터 줄 id = paper 항목 id
    const vectorRow = id => vectorRows(paintLayer(ep())?.layer).find(row => String(row.item.id) === id) || null;
    const vectorTarget = () => vectorPrimary(ep(), vectorRows(paintLayer(ep())?.layer));
    const toggle = button('레이어', () => { layerUi.open = !layerUi.open; renderLayerPanel(ep(), layerMeta(ep())); },
      { class: 'evr-layers-toggle' });
    const list = document.createElement('ol');
    list.className = 'evr-layers-list';
    let thumbFrame = 0;
    list.addEventListener('scroll', () => {
      if (!thumbFrame) thumbFrame = requestAnimationFrame(() => { thumbFrame = 0; fillVisibleThumbs(ep(), panel); });
    });
    // 손잡이 끌기: 놓은 줄 사이에 넣는다(목록 위 = 앞). 끄는 동안 넣을 자리에 선을 보이고, 목록 끝에 가면 굴린다.
    let reorder = null, swallowClick = false;
    const dropIndex = y => {
      const rows = [...list.children];
      let at = rows.length;
      for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { at = i; break; } }
      return at;
    };
    const markDrop = at => {
      [...list.children].forEach((row, i) => {
        const mark = at === i ? 'before' : at === list.children.length && i === list.children.length - 1 ? 'after' : '';
        if ((row.dataset.drop || '') !== mark) { if (mark) row.dataset.drop = mark; else delete row.dataset.drop; }
      });
    };
    list.addEventListener('pointerdown', event => {
      const grip = event.target.closest('.evr-layer-grip'), row = grip?.closest('.evr-layer');
      if (!row || event.button !== 0 || list.children.length < 2) return;
      event.preventDefault();
      reorder = { id: row.dataset.id, from: [...list.children].indexOf(row), at: null, pointer: event.pointerId };
      row.dataset.dragging = 'true';
      panel.dataset.reordering = 'true'; // 끄는 동안 창을 다시 그리지 않는다(줄이 바뀌면 끌기가 끊김)
      try { grip.setPointerCapture(event.pointerId); } catch {}
    });
    list.addEventListener('pointermove', event => {
      if (!reorder || event.pointerId !== reorder.pointer) return;
      const box = list.getBoundingClientRect();
      if (event.clientY < box.top + 16) list.scrollTop -= 8;
      else if (event.clientY > box.bottom - 16) list.scrollTop += 8;
      reorder.at = dropIndex(event.clientY);
      markDrop(reorder.at);
    });
    const endReorder = event => {
      if (!reorder || event.pointerId !== reorder.pointer) return;
      const job = reorder;
      reorder = null;
      delete panel.dataset.reordering;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
      [...list.children].forEach(row => { delete row.dataset.drop; delete row.dataset.dragging; });
      if (event.type !== 'pointerup' || job.at === null) return;
      // 화면 줄(위 = 앞)에서 넣을 자리 → 레이어 목록(아래부터) 번호
      const n = list.children.length, place = job.at > job.from ? job.at - 1 : job.at;
      if (place === job.from) return;
      const editor = ep(), to = n - 1 - place;
      if (vector()) vectorMoveTo(editor, job.id, to); else moveLayerTo(editor, job.id, to);
    };
    list.addEventListener('pointerup', endReorder);
    list.addEventListener('pointercancel', endReorder);
    list.addEventListener('lostpointercapture', endReorder); // 놓기를 못 받았을 때도 끌기 상태를 정리(옮기지는 않음)
    list.addEventListener('click', event => {
      if (swallowClick || event.target.closest('.evr-layer-grip')) return;
      const row = event.target.closest('.evr-layer');
      if (!row) return;
      const id = row.dataset.id, editor = ep();
      if (vector()) {
        const target = vectorRow(id);
        if (!target) return;
        if (event.target.closest('.evr-layer-eye')) setVectorProp(editor, target.item, 'visible', !target.item.visible);
        else { layerUi.vectorPick = target.item; selectVectorUnit(target.item); renderLayerPanel(editor, null); }
        return;
      }
      if (event.target.closest('.evr-layer-eye')) {
        const meta = ensureLayerMeta(editor);
        const layer = meta?.layers.find(item => item.id === (id || meta.active));
        if (layer) setLayerProp(editor, layer.id, 'visible', !layer.visible);
        return;
      }
      if (id) selectBitmapLayer(editor, id);
    });
    list.addEventListener('dblclick', event => {
      const row = event.target.closest('.evr-layer');
      if (!row) return;
      const editor = ep();
      if (vector()) {
        const target = vectorRow(row.dataset.id);
        const name = target && window.prompt('레이어 이름', target.name);
        if (name && name.trim()) setVectorProp(editor, target.item, 'name', name.trim().slice(0, 40));
        return;
      }
      const meta = ensureLayerMeta(editor);
      const layer = meta?.layers.find(item => item.id === (row.dataset.id || meta.active));
      if (!layer) return;
      const name = window.prompt('레이어 이름', layer.name);
      if (name && name.trim()) setLayerProp(editor, layer.id, 'name', name.trim().slice(0, 40));
    });
    const level = document.createElement('label');
    level.className = 'evr-brush-level evr-layers-opacity';
    level.title = '지금 레이어 불투명도(0% = 안 보임)';
    const text = document.createElement('span');
    text.textContent = '불투명도';
    const range = document.createElement('input');
    Object.assign(range, { type: 'range', min: '0', max: '100', step: '1' });
    const value = document.createElement('b');
    range.addEventListener('input', () => {
      const editor = ep();
      if (vector()) {
        const target = vectorTarget();
        if (!target) return;
        value.textContent = `${range.value}%`;
        setVectorProp(editor, target.item, 'opacity', Number(range.value) / 100, false);
        return;
      }
      const meta = ensureLayerMeta(editor);
      if (!meta) return;
      value.textContent = `${range.value}%`;
      setLayerProp(editor, meta.active, 'opacity', Number(range.value) / 100, false);
    });
    range.addEventListener('change', () => { if (vector()) saveVectorLayers(ep()); else commitLayers(ep()); });
    range.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.stopPropagation();
    });
    level.append(text, range, value);
    const clip = button('클리핑', () => {
      const editor = ep();
      if (vector()) { vectorLayerAction(editor, 'clip'); return; }
      const meta = ensureLayerMeta(editor);
      if (meta) setLayerProp(editor, meta.active, 'clip', !activeLayer(meta).clip);
    }, { class: 'evr-brush-toggle evr-layers-clip', title: '클리핑 마스크: 바로 아래 레이어의 칠해진 모양 안에서만 보이게(지워지지 않음)' });
    const lock = button('투명 잠금', () => { if (vector()) return; toggleAlphaLock(); renderLayerPanel(ep(), layerMeta(ep())); },
      { class: 'evr-brush-toggle evr-layers-lock' });
    const filter = button('필터', () => openFilterPanel(ep()),
      { class: 'evr-brush-toggle evr-layers-filter', title: '지금 레이어에 필터(밝기·대비·채도·색조·흑백·세피아·색 반전·흐림·모자이크·외곽선·그림자)' });
    const props = document.createElement('div');
    props.className = 'evr-layers-props';
    props.append(level, clip, lock, filter);
    // 같은 단추가 모드에 따라 비트맵 레이어 또는 벡터 레이어(맨 위 도형)를 고친다
    const act = (label, cls, title, bitmap, kind) => button(label, () => {
      const editor = ep();
      if (editor?.mode === 'VECTOR') { if (kind) vectorLayerAction(editor, kind); }
      else bitmap(editor);
    }, { class: `evr-layers-act ${cls}`, title });
    const actions = document.createElement('div');
    actions.className = 'evr-layers-actions';
    actions.append(
      act('＋', 'evr-layers-add', '새 레이어(지금 레이어 위)', addLayer, null),
      act('복제', 'evr-layers-dup', '지금 레이어 복제', duplicateLayer, 'dup'),
      act('▲', 'evr-layers-up', '앞으로(위로)', editor => moveLayer(editor, 1), 'up'),
      act('▼', 'evr-layers-down', '뒤로(아래로)', editor => moveLayer(editor, -1), 'down'),
      act('합치기', 'evr-layers-merge', '아래 레이어와 합치기', mergeLayerDown, 'merge'),
      act('삭제', 'evr-layers-del', '지금 레이어 삭제', deleteLayer, 'del'));
    const body = document.createElement('div');
    body.className = 'evr-layers-body';
    body.append(list, props, actions);
    panel.append(toggle, body);
    // 창 위 마우스가 엔트리 그림판(문서 mousemove로 받음)으로 가지 않게
    for (const type of ['mousemove', 'pointermove', 'mousedown', 'pointerdown', 'wheel']) panel.addEventListener(type, event => event.stopPropagation());
    return panel;
  }
  // 창에 그릴 내용: rows(아래부터 { id, name, visible, opacity, clip, lock }), primary(단추·불투명도가 고칠 줄), selected(칠할 줄 id),
  // thumb(줄 → 40×24 캔버스), key(바뀌었을 때만 다시 그림)
  function bitmapLayerView(ep, meta) {
    const layers = meta ? meta.layers : [{ id: '', name: '레이어 1', visible: true, opacity: 1, clip: false, lock: pixelPen.alphaLock }];
    const active = meta ? activeLayer(meta) : layers[0];
    const parts = paintLayer(ep), paintId = parts?.layer.children[0]?.id ?? '';
    const stageKey = parts?.stage ? [parts.stage.x, parts.stage.y, parts.stage.width, parts.stage.height].map(Math.round) : null;
    const structKey = [layers.map(l => [l.id, l.name, l.visible, l.opacity, l.clip, l.lock, l.ref]), active.id, stageKey]; // 무대 크기: 다른 줄 작은 그림이 바뀜
    const used = new Set(); // 이번에 그리는 목록에 이미 넣은 작은 그림(같은 내용을 두 줄이 쓰면 둘째부터 사본)
    return {
      rows: layers, primary: active, selected: new Set([active.id]), canAdd: true, canLock: true,
      key: [...structKey, paintId], structKey,
      thumb: layer => {
        const stage = parts?.stage;
        const draw = content => {
          const thumb = canvasOfSize(40, 24);
          if (content && stage) {
            const g = thumb.getContext('2d'), k = Math.min(40 / stage.width, 24 / stage.height);
            g.drawImage(content.canvas, (content.x - stage.x) * k + (40 - stage.width * k) / 2, (content.y - stage.y) * k + (24 - stage.height * k) / 2,
              content.canvas.width * k, content.canvas.height * k);
          }
          return thumb;
        };
        if (layer === active) return draw(paintSnapshot(ep));
        // 다른 레이어: 그림 참조는 한 번 만들면 바뀌지 않으므로 작은 그림을 그 내용에 붙여 두고 사본만 돌려준다(레이어가 많으면 창을 다시
        // 그릴 때마다 큰 그림을 줄마다 줄여 그려 느렸다 — 실측 1000장 100ms)
        const content = layer.ref && layerCache.get(layer.ref), key = stage && `${stage.x},${stage.y},${stage.width},${stage.height}`;
        if (!content) return draw(null);
        if (!content.thumb || content.thumbKey !== key) { content.thumb = draw(content); content.thumbKey = key; }
        if (used.has(content.thumb)) return copyCanvas(content.thumb);
        used.add(content.thumb);
        return content.thumb;
      },
    };
  }
  function vectorLayerView(ep) {
    const rows = vectorRows(paintLayer(ep)?.layer);
    const picked = vectorPicked(ep, rows), primaryRow = vectorPrimary(ep, rows);
    const view = rows.map(row => ({ id: String(row.item.id), name: row.name, visible: row.item.visible, opacity: row.item.opacity,
      clip: row.clip, lock: false, item: row.item }));
    const primary = primaryRow ? view[primaryRow.index] : null, selected = new Set(picked.map(row => String(row.item.id)));
    return {
      rows: view, primary, selected, canAdd: false, canLock: false,
      // 창에서 누른 줄 기록도 넣는다 — 기록만 지워지면(선택은 앞뒤 모두 없음) 창을 다시 안 그려 [필터] 설명이 낡은 채 남았음(시험)
      key: [view.map(l => [l.id, l.name, l.visible, l.opacity, l.clip]), primary?.id ?? null, [...selected], layerUi.vectorEpoch, layerUi.vectorPick ? String(layerUi.vectorPick.id) : null],
      thumb: layer => vectorThumb(ep, layer.item, true),
    };
  }
  // 목록에서 보이는(위아래 여유 120px) 줄 중 빈 작은 그림만 굽는다
  function fillVisibleThumbs(ep, panel) {
    const list = panel?.querySelector('.evr-layers-list'), rows = layerUi.panelRows;
    if (!list || !rows || ep?.mode !== 'VECTOR') return;
    const box = list.getBoundingClientRect(), byId = new Map(rows.map(layer => [layer.id, layer]));
    for (const row of list.children) {
      const thumb = row.querySelector('.evr-layer-thumb');
      if (thumb?.dataset.pending !== '1') continue;
      const r = row.getBoundingClientRect();
      if (r.bottom < box.top - 120 || r.top > box.bottom + 120) continue;
      const layer = byId.get(row.dataset.id);
      if (!layer) continue;
      const fresh = vectorThumb(ep, layer.item);
      fresh.className = 'evr-layer-thumb';
      thumb.replaceWith(fresh);
    }
  }
  function renderLayerPanel(ep, meta) {
    const area = document.querySelector('#entryPainter .canvas_area');
    let panel = layerUi.panel;
    const mode = ep?.mode;
    // 창을 치울 때 끄는 중 표시도 지운다(남으면 다음에 창을 다시 그리지 않음 — 검토 지적)
    if (!area || mode !== 'BITMAP' && mode !== 'VECTOR' || session) { if (panel) { delete panel.dataset.reordering; panel.remove(); } return; }
    if (!panel) panel = layerUi.panel = buildLayerPanel();
    if (panel.parentElement !== area) area.append(panel);
    if (panel.dataset.reordering === 'true') return;
    // 접혀 있으면 줄 수만 센다(0.5초마다 도므로 선택·작은 그림 계산은 펼쳤을 때만)
    const view = !layerUi.open ? { rows: { length: mode === 'VECTOR' ? vectorRows(paintLayer(ep)?.layer).length : meta ? meta.layers.length : 1 } }
      : mode === 'VECTOR' ? vectorLayerView(ep) : bitmapLayerView(ep, meta);
    const key = JSON.stringify([mode, layerUi.open ? view.key : view.rows.length, layerUi.open]);
    if (panel.dataset.key === key) return;
    // 비트맵에서 지금 레이어 그림만 바뀌었으면(붓질마다 엔트리가 그림을 새로 바꿈) 그 줄 작은 그림만 바꾼다 — 레이어가 많으면 줄 전체를
    // 다시 그려 붓질마다 느렸다(실측 1000장)
    const struct = layerUi.open && mode === 'BITMAP' && view.structKey ? JSON.stringify(view.structKey) : '';
    if (struct && panel.dataset.struct === struct) {
      const old = [...panel.querySelectorAll('.evr-layer')].find(row => row.dataset.id === view.primary.id)?.querySelector('.evr-layer-thumb');
      if (old) {
        const thumb = view.thumb(view.primary);
        thumb.className = 'evr-layer-thumb';
        old.replaceWith(thumb);
        panel.dataset.key = key;
        return;
      }
    }
    panel.dataset.key = key;
    panel.dataset.struct = struct;
    panel.dataset.open = String(layerUi.open);
    panel.dataset.graphics = mode;
    const toggle = panel.querySelector('.evr-layers-toggle');
    toggle.textContent = `레이어 ${view.rows.length}개 ${layerUi.open ? '▴' : '▾'}`;
    toggle.title = mode === 'VECTOR' ? '확장: 레이어(벡터는 맨 위 도형 하나가 레이어 — 엔트리 앞으로·뒤로·그룹과 같음)'
      : '확장: 비트맵 레이어(편집은 확장이 있을 때, 저장하면 합친 그림이 보임)';
    if (!layerUi.open) return;
    const list = panel.querySelector('.evr-layers-list');
    list.replaceChildren(...view.rows.slice().reverse().map(layer => {
      const row = document.createElement('li');
      row.className = 'evr-layer';
      row.dataset.id = layer.id;
      row.setAttribute('aria-selected', String(view.selected.has(layer.id)));
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'evr-layer-eye';
      eye.textContent = layer.visible ? '●' : '○';
      eye.title = layer.visible ? '숨기기' : '보이기';
      eye.setAttribute('aria-pressed', String(layer.visible));
      const thumb = view.thumb(layer);
      thumb.className = 'evr-layer-thumb';
      const name = document.createElement('span');
      name.className = 'evr-layer-name';
      name.textContent = `${layer.clip ? '↳ ' : ''}${layer.name}`;
      name.title = '두 번 눌러 이름 바꾸기';
      const badges = document.createElement('span');
      badges.className = 'evr-layer-badges';
      badges.textContent = [layer.lock ? '잠금' : '', layer.opacity !== 1 ? `${Math.round(layer.opacity * 100)}%` : ''].filter(Boolean).join(' ');
      // 순서 바꾸기 손잡이(이비스페인트 레이어 창처럼 줄 오른쪽, 위아래로 끌기)
      const grip = document.createElement('span');
      grip.className = 'evr-layer-grip';
      grip.textContent = '≡';
      grip.title = '위아래로 끌어 순서 바꾸기';
      row.append(eye, thumb, name, badges, grip);
      return row;
    }));
    layerUi.panelRows = mode === 'VECTOR' ? view.rows : null;
    if (mode === 'VECTOR') fillVisibleThumbs(ep, panel);
    const active = view.primary, percent = Math.round((active ? active.opacity : 1) * 100);
    const range = panel.querySelector('.evr-layers-opacity input');
    range.disabled = !active;
    if (document.activeElement !== range) range.value = String(percent);
    panel.querySelector('.evr-layers-opacity b').textContent = `${percent}%`;
    const clip = panel.querySelector('.evr-layers-clip'), lock = panel.querySelector('.evr-layers-lock'), add = panel.querySelector('.evr-layers-add');
    clip.setAttribute('aria-pressed', String(!!active?.clip));
    lock.setAttribute('aria-pressed', String(!!active?.lock));
    lock.disabled = !view.canLock;
    lock.title = view.canLock ? '이 레이어의 칠해진 곳에만 그림(붓·선·영역 채우기)' : '투명 잠금은 비트맵 레이어에서만(포토샵도 벡터 모양 레이어에는 없음)';
    const filterButton = panel.querySelector('.evr-layers-filter');
    // 포토샵처럼 숨긴 레이어·여러 레이어에는 걸지 않는다(숨긴 레이어는 결과가 안 보이고, 여러 줄이면 어디에 걸지 모름 — 예전엔 숨긴 채 걸리거나
    // 여러 줄 중 하나에만 말없이 걸렸음, 10-19)
    // 벡터는 숨긴 도형을 엔트리 선택에서 곧 빼므로(선택 윤곽선 다시 맞추기) 레이어 창에서 숨긴 줄을 누르면 고른 레이어가 없어진다 — 그때도 숨김이 이유.
    // 창에서 누른 줄 기록이 낡으면 watchVectorPick이 지운다.
    const pickedHidden = mode === 'VECTOR' && !active && layerUi.vectorPick?.visible === false && view.rows?.some?.(row => row.item === layerUi.vectorPick);
    const pickedMany = mode === 'VECTOR' && (view.selected?.size || 0) > 1, hiddenActive = (!!active && active.visible === false) || !!pickedHidden;
    filterButton.disabled = (mode === 'VECTOR' && !active) || pickedMany || hiddenActive;
    filterButton.title = hiddenActive ? '숨긴 레이어에는 필터를 걸 수 없습니다 — 보이게 한 뒤 거세요(포토샵과 같음)'
      : pickedMany ? '레이어를 하나만 고르세요 — 필터는 한 번에 레이어 하나에 겁니다(포토샵과 같음)'
        : mode === 'BITMAP' ? '지금 레이어에 필터(밝기·대비·채도·색조·흑백·세피아·색 반전·흐림·모자이크·외곽선·그림자)'
          : active ? '고른 레이어에 필터 — 색 필터는 도형 색만 바꿔 벡터로 남고, 흐림·모자이크·외곽선·그림자는 그 레이어를 그림으로 바꿔 적용'
            : '필터를 걸 레이어를 먼저 고르세요';
    add.disabled = !view.canAdd;
    add.title = view.canAdd ? '새 레이어(지금 레이어 위)' : '벡터는 새로 그린 도형 하나가 레이어 하나입니다';
    const rows = view.rows, at = active ? rows.indexOf(active) : -1, many = rows.length > 1;
    panel.querySelector('.evr-layers-dup').disabled = !active;
    panel.querySelector('.evr-layers-up').disabled = !active || !many || at === rows.length - 1;
    panel.querySelector('.evr-layers-down').disabled = !active || !many || at === 0;
    panel.querySelector('.evr-layers-merge').disabled = !active || !many || at === 0;
    panel.querySelector('.evr-layers-del').disabled = !active || !many;
    clip.disabled = !active || at === 0;
  }
  // ---- 필터(1.3, 사용자 요청 "각종 필터") ----
  // 비트맵 지금 레이어(그림 층 내용)에 건다. 벡터 도형은 흐림 같은 필터가 저장 SVG에 남지 않아 비트맵만. 계산은 표준 그대로: 색·흐림·그림자 =
  // 캔버스 filter(CSS 필터 함수), 모자이크 = 줄였다 보간 없이 키우기, 외곽선 = 실루엣을 반지름 안 정수 칸마다 찍기(도장 외곽선).
  // 미리보기는 그림 층에 결과 한 장을 넣어 보이고, [취소]는 떼어 둔 원래 항목을 그대로 되돌리고, [적용]은 되돌리기 기록을 한 번 남긴다.
  // 투명 잠금이 켜져 있으면 원래 칠해진 곳의 투명도를 그대로 둔다(색만 바뀜, 외곽선·그림자는 칠해진 곳 밖에 안 생김).
  const FILTERS = [
    { id: 'brightness', label: '밝기', params: [{ key: 'v', label: '밝기', min: 0, max: 200, value: 120, unit: '%' }], css: p => `brightness(${p.v}%)` },
    { id: 'contrast', label: '대비', params: [{ key: 'v', label: '대비', min: 0, max: 200, value: 130, unit: '%' }], css: p => `contrast(${p.v}%)` },
    { id: 'saturate', label: '채도', params: [{ key: 'v', label: '채도', min: 0, max: 300, value: 150, unit: '%' }], css: p => `saturate(${p.v}%)` },
    { id: 'hue', label: '색조', params: [{ key: 'v', label: '돌리기', min: -180, max: 180, value: 90, unit: '°' }], css: p => `hue-rotate(${p.v}deg)` },
    { id: 'grayscale', label: '흑백', params: [{ key: 'v', label: '세기', min: 0, max: 100, value: 100, unit: '%' }], css: p => `grayscale(${p.v}%)` },
    { id: 'sepia', label: '세피아', params: [{ key: 'v', label: '세기', min: 0, max: 100, value: 100, unit: '%' }], css: p => `sepia(${p.v}%)` },
    { id: 'invert', label: '색 반전', params: [{ key: 'v', label: '세기', min: 0, max: 100, value: 100, unit: '%' }], css: p => `invert(${p.v}%)` },
    { id: 'blur', label: '흐림', params: [{ key: 'v', label: '반지름', min: 0, max: 20, value: 2, unit: 'px' }], css: p => `blur(${p.v}px)`, pad: p => Math.ceil(p.v * 3) },
    { id: 'mosaic', label: '모자이크', params: [{ key: 'v', label: '칸 크기', min: 2, max: 32, value: 8, unit: 'px' }] },
    { id: 'outline', label: '외곽선', params: [{ key: 'v', label: '두께', min: 1, max: 10, value: 2, unit: 'px' }, { key: 'color', label: '색', type: 'color', value: '#000000' }], pad: p => p.v + 1 },
    { id: 'shadow', label: '그림자', params: [{ key: 'x', label: '가로', min: -20, max: 20, value: 4, unit: 'px' }, { key: 'y', label: '세로', min: -20, max: 20, value: 4, unit: 'px' },
      { key: 'b', label: '흐림', min: 0, max: 20, value: 2, unit: 'px' }, { key: 'a', label: '진하기', min: 0, max: 100, value: 50, unit: '%' }, { key: 'color', label: '색', type: 'color', value: '#000000' }],
    css: p => `drop-shadow(${p.x}px ${p.y}px ${p.b}px ${hexAlpha(p.color, p.a / 100)})`, pad: p => Math.max(Math.abs(p.x), Math.abs(p.y)) + Math.ceil(p.b * 3) },
  ];
  const hexAlpha = (hex, alpha) => {
    const n = parseInt(String(hex).slice(1), 16) || 0;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
  };
  // 칠해진 범위로 자른 사본(픽셀 모양은 칸 크기 grid에 맞춰 — 확장이 픽셀 모양 그림 왼쪽 위를 칸 배수로 맞추므로 어긋나지 않게).
  // 하나도 안 칠해졌으면 null.
  function trimFilterContent(content, grid = 1) {
    if (!content) return null;
    const { width: w, height: h } = content.canvas;
    const d = content.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0, p = 3; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
      if (!d[p]) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0) return null;
    const x0 = Math.floor(minX / grid) * grid, y0 = Math.floor(minY / grid) * grid;
    const x1 = Math.min(w, Math.ceil((maxX + 1) / grid) * grid), y1 = Math.min(h, Math.ceil((maxY + 1) / grid) * grid);
    if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return content;
    const canvas = canvasOfSize(x1 - x0, y1 - y0);
    canvas.getContext('2d').drawImage(content.canvas, -x0, -y0);
    return { canvas, x: content.x + x0, y: content.y + y0 };
  }
  // 원본 { canvas, x, y } → 필터 건 { canvas, x, y }(번지는 필터는 둘레를 넓힘 — 픽셀 모양은 칸 크기 배수로)
  function filteredContent(source, filter, params, keepAlpha, grid = 1) {
    const pad = filter.pad ? Math.ceil(Math.max(0, filter.pad(params)) / grid) * grid : 0;
    const w = source.canvas.width + pad * 2, h = source.canvas.height + pad * 2;
    const out = canvasOfSize(w, h), g = out.getContext('2d', { willReadFrequently: true });
    if (filter.id === 'mosaic') {
      const k = Math.max(1, params.v), sw = Math.max(1, Math.ceil(source.canvas.width / k)), sh = Math.max(1, Math.ceil(source.canvas.height / k));
      const small = canvasOfSize(sw, sh), sg = small.getContext('2d');
      sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
      sg.drawImage(source.canvas, 0, 0, sw, sh);
      g.imageSmoothingEnabled = false;
      g.drawImage(small, 0, 0, sw, sh, pad, pad, sw * k, sh * k);
    } else if (filter.id === 'outline') {
      // 실루엣(외곽선 색)을 반지름 안 정수 칸마다 찍고 그 위에 원본
      const tint = canvasOfSize(source.canvas.width, source.canvas.height), tg = tint.getContext('2d');
      tg.drawImage(source.canvas, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = params.color;
      tg.fillRect(0, 0, tint.width, tint.height);
      const r = params.v;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) g.drawImage(tint, pad + dx, pad + dy);
      g.drawImage(source.canvas, pad, pad);
    } else {
      g.filter = filter.css(params);
      g.drawImage(source.canvas, pad, pad);
      g.filter = 'none';
    }
    if (keepAlpha) {
      // 투명 잠금: 원래 칠해진 곳 투명도 그대로(둘레는 투명)
      const base = canvasOfSize(w, h), bg = base.getContext('2d', { willReadFrequently: true });
      bg.drawImage(source.canvas, pad, pad);
      const a = bg.getImageData(0, 0, w, h).data, image = g.getImageData(0, 0, w, h), d = image.data;
      for (let p = 0; p < d.length; p += 4) {
        if (!a[p + 3]) { d[p + 3] = 0; continue; }
        if (!d[p + 3]) { d[p] = a[p]; d[p + 1] = a[p + 1]; d[p + 2] = a[p + 2]; }
        d[p + 3] = a[p + 3];
      }
      g.putImageData(image, 0, 0);
    }
    return { canvas: out, x: source.x - pad, y: source.y - pad };
  }
  // 필터 창이 열려 있는 동안은 이비스페인트 필터 화면처럼 나머지를 막는다(덮개 + 단축키 막기, Esc = 취소, Enter = 적용) — 미리보기가
  // 모양 바꾸기·저장(Ctrl+S)·되돌리기로 다른 곳에 저장되거나 꼬이지 않게.
  let filterUi = null; // { panel, shade, keys, ep, fileId, layer, original: [항목], preview, source, filter, params }
  function contentRaster(ep, content) {
    const raster = new ep.paper.Raster({ canvas: content.canvas, insert: false });
    raster.position = new ep.paper.Point(content.x + content.canvas.width / 2, content.y + content.canvas.height / 2);
    return raster;
  }
  function openFilterPanel(ep) {
    if (filterUi) return;
    if (ep?.mode === 'VECTOR') { openVectorFilterPanel(ep); return; }
    if (ep?.mode !== 'BITMAP') return;
    const parts = paintLayer(ep), area = document.querySelector('#entryPainter .canvas_area');
    if (!parts || !area) return;
    const meta = layerMeta(ep), shown = meta ? activeLayer(meta) : null;
    if (shown && shown.visible === false) { toast('숨긴 레이어에는 필터를 걸 수 없습니다 — 보이게 한 뒤 거세요.', 3000); return; }
    paintStore()?.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    // 칠해진 범위로 자른 원본(새 레이어는 투명한 그림 한 장이라 그림이 있어도 칠해진 화소가 없을 수 있음 → null). 범위만 계산해
    // 큰 그림판에서도 외곽선 등이 가볍다(검토 지적).
    const c = context(), grid = c && pixelOf(c.picture) ? editorScale(c) : 1;
    const source = trimFilterContent(paintSnapshot(ep), grid);
    if (!source) { toast('지금 레이어에 그림이 없어 필터를 걸 수 없습니다.', 2500); return; }
    // 첫 미리보기를 원본을 떼기 전에 만든다 — 계산이 실패하면 아무것도 바꾸지 않는다(검토 지적: 떼고 나서 실패하면 빈 레이어가 적용될 수 있었음)
    let first;
    try { first = filteredContent(source, FILTERS[0], Object.fromEntries(FILTERS[0].params.map(param => [param.key, param.value])), !!pixelPen.alphaLock, grid); }
    catch (error) { console.warn('[entry-vector-rig] 필터', error); toast('필터를 열 수 없습니다.', 2500); return; }
    const original = parts.layer.removeChildren() || [];
    mountFilterUi(ep, area, { kind: 'bitmap', layer: parts.layer, original, source, grid }, first);
  }
  // 필터 창 띄우기(비트맵·벡터 같이): 덮개, 키 막기, 창 자리. state에 대상별 값(kind 등)
  function mountFilterUi(ep, area, state, first) {
    const fileId = window.Entry?.playground?.painter?.file?.id;
    const shade = document.createElement('div');
    shade.className = 'evr-filter-shade';
    for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick', 'wheel', 'contextmenu']) shade.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    const panel = buildFilterPanel(ep);
    const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const keys = event => {
      // 엔트리 색 고르기 창(창 밖, 페이지 맨 위) 안: Esc는 고르기 창만 닫고(검토 지적: 예전엔 필터 전체가 취소됨), 다른 키는 그 칸에 둔다
      // (고르기 창이 키를 그림판으로 보내지 않음 — openEntryPicker)
      if (event.target?.closest?.('.evr-entry-picker')) {
        if (event.key === 'Escape') { block(event); closeEntryPicker(); }
        // 단축키(Ctrl·Cmd·Alt)는 칸 안 편집(Ctrl+A 등)만 하고 엔트리로는 보내지 않는다(기본 동작은 막지 않음 — 검토 지적)
        else if (event.ctrlKey || event.metaKey || event.altKey) event.stopImmediatePropagation();
        return;
      }
      if (event.key === 'Escape') { block(event); closeFilterPanel(false); return; }
      // 단추에 초점이 있으면 Enter는 그 단추 누르기(필터 고르기·취소)로 둔다 — 예전엔 어디서든 적용돼 [취소]에서 Enter가 적용됐다(검토 지적)
      if (event.key === 'Enter' && panel.contains(event.target) && event.target?.tagName === 'BUTTON') return;
      if (event.key === 'Enter') { block(event); closeFilterPanel(true); return; }
      // 단축키(Ctrl·Cmd·Alt — 저장·되돌리기 등)는 초점이 어디든 엔트리로 보내지 않는다(창 단추를 누른 뒤엔 초점이 창 안이라 시험에서 잡힘).
      // 창 안 막대 조절 키(방향키 등)만 통과, 창 밖 키는 모두 막는다.
      if (event.ctrlKey || event.metaKey || event.altKey || !panel.contains(event.target)) block(event);
    };
    window.addEventListener('keydown', keys, true);
    filterUi = { ...state, panel, shade, keys, ep, fileId, preview: null, result: null, filter: FILTERS[0], params: null };
    const rect = area.getBoundingClientRect();
    Object.assign(panel.style, { left: `${Math.round(rect.left + 12)}px`, top: `${Math.round(rect.top + 12)}px` });
    document.body.append(shade, panel);
    showFilterResult(first);
    selectFilter(FILTERS[0]);
  }
  // ---- 벡터 필터(1.3, 사용자 요청 10-18 "백터에서도 필터 돼게", 사용자 결정: 색 필터는 벡터 그대로) ----
  // 대상 = 레이어 창의 지금 벡터 레이어(맨 위 항목). 색 필터(밝기·대비·채도·색조·흑백·세피아·색 반전)는 칠·선 색(그라데이션 정지점 포함)과
  // 안에 든 그림 화소만 바꿔 벡터로 남긴다 — 색 계산은 비트맵과 같은 브라우저 표준 CSS 필터(1×1 칸에 그려 읽음). 흐림·모자이크·외곽선·
  // 그림자는 저장 SVG에 남길 수 없어 그 레이어를 그림(Raster, 그림 좌표 1:1)으로 구운 뒤 비트맵과 같은 계산으로 건다(이름·불투명도·
  // 클리핑 표시는 그대로). 미리보기 동안 원래 항목은 숨겨 두고 바로 위에 미리보기 항목을 둔다. 적용 = 원래 항목을 결과로 바꾸고 되돌리기 기록 한 번.
  const COLOR_FILTERS = new Set(['brightness', 'contrast', 'saturate', 'hue', 'grayscale', 'sepia', 'invert']);
  let filterColorCtx = null;
  const filterColorCache = new Map();
  function filterColor(paper, color, css) {
    if (!color) return color;
    if (color.gradient) {
      return new paper.Color({ gradient: { stops: color.gradient.stops.map(stop => new paper.GradientStop(filterColor(paper, stop.color, css), stop.offset)), radial: color.gradient.radial },
        origin: color.origin, destination: color.destination, highlight: color.highlight });
    }
    const r = Math.round(color.red * 255), g = Math.round(color.green * 255), b = Math.round(color.blue * 255), key = `${css}|${r},${g},${b}`;
    let out = filterColorCache.get(key);
    if (!out) {
      filterColorCtx ||= canvasOfSize(1, 1).getContext('2d', { willReadFrequently: true });
      const ctx = filterColorCtx;
      ctx.clearRect(0, 0, 1, 1);
      ctx.filter = css;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 1, 1);
      ctx.filter = 'none';
      out = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
      if (filterColorCache.size > 4096) filterColorCache.clear();
      filterColorCache.set(key, out);
    }
    return new paper.Color(out[0] / 255, out[1] / 255, out[2] / 255, color.alpha);
  }
  function filterRasterPixels(raster, css) {
    const w = raster.width, h = raster.height;
    if (!w || !h) return;
    const canvas = canvasOfSize(w, h), g = canvas.getContext('2d');
    g.filter = css;
    g.drawImage(raster.canvas, 0, 0);
    replaceRasterImage(raster, canvas);
  }
  // 대상 항목에 필터를 건 새 항목(문서에 넣지 않음). cache = 창 하나 동안 구운 원본을 두는 곳(막대를 움직일 때마다 다시 굽지 않게 — 검토 지적)
  function vectorFilteredItem(ep, target, filter, params, cache) {
    const P = ep.paper;
    if (COLOR_FILTERS.has(filter.id)) {
      const css = filter.css(params), copy = target.clone({ insert: false });
      const from = [target, ...target.getItems({ match: () => true })], to = [copy, ...copy.getItems({ match: () => true })];
      to.forEach((item, i) => {
        // paper 복제는 같은 부모 안 이름이 겹치면 " 1"을 붙인다(안쪽 이름이 필터마다 쌓였음 — 시험으로 재현) — 원래 이름으로. 복제는 data를
        // 통째로 복사하므로 엔트리 선택 표시·윤곽선 참조는 지운다(레이어 복제와 같음)
        if (from.length === to.length && item.name !== from[i].name) item.name = from[i].name;
        delete item.data.selected;
        delete item.data.guideItem;
      });
      for (const item of to) {
        // 클리핑 마스크 틀(과 그 안)은 칠이 지워진 채 색을 따로 적어 둔다 — 그 적어 둔 색에 건다(새 객체 — 복제는 data를 얕게 복사해 원래와 같이 씀)
        if (item.data?.evrMaskStyle) item.data.evrMaskStyle = filterMaskStyle(P, item.data.evrMaskStyle, css);
        if (item.clipMask) continue; // 틀 모양은 색이 아니라 모양만 쓴다
        if (item.className === 'Raster') { filterRasterPixels(item, css); continue; }
        // 묶음의 색은 자식 색을 읽고 쓰는 길이다(paper 0.12.15 Style: 자식 색이 같으면 그 색, 넣으면 자식 모두에 퍼짐) — 묶음에 걸고 자식에
        // 또 걸면 두 번 걸렸다(같은 색 묶음에 색 반전 = 그대로, 시험으로 재현). 묶음은 건너뛰고 도형마다 한 번만. 복합 경로는 자기 색이다.
        if (item.children && item.className !== 'CompoundPath') continue;
        if (item.fillColor) item.fillColor = filterColor(P, item.fillColor, css);
        if (item.strokeColor) item.strokeColor = filterColor(P, item.strokeColor, css);
      }
      copy.visible = true;
      return copy;
    }
    // 그림으로 구워 비트맵과 같은 계산: 불투명도·숨김·합성 모드는 빼고 내용만 굽고(항목 속성으로 되돌림). 클리핑 레이어도 잘리지 않은 내용으로
    // 굽는다(결과에 클리핑 표시를 그대로 두어 화면에서 다시 잘림 — 예전엔 잘린 채 굳어 기준 밖이 사라졌음, 시험으로 재현. 작은 그림과 같음)
    const opacity = target.opacity, visible = target.visible, blendMode = target.blendMode;
    let source = cache?.vectorSource;
    if (!source) {
      target.opacity = 1; target.visible = true; target.blendMode = 'normal';
      clipDrawOff++;
      let raster;
      try { raster = target.rasterize({ resolution: 72, insert: false }); }
      finally { clipDrawOff--; target.opacity = opacity; target.visible = visible; target.blendMode = blendMode; }
      if (!raster?.width || !raster.height) throw Error('그림으로 바꿀 내용이 없습니다');
      const b = raster.bounds;
      source = { canvas: rasterCopy(raster), x: Math.round(b.x), y: Math.round(b.y) };
      if (cache) cache.vectorSource = source;
    }
    const filtered = trimFilterContent(filteredContent(source, filter, params, false, 1), 1);
    // 다 투명해졌으면 원본 그대로(구운 원본은 다음 미리보기에도 쓰므로 사본으로)
    const out = contentRaster(ep, filtered || { canvas: rasterCopy({ width: source.canvas.width, height: source.canvas.height, canvas: source.canvas }), x: source.x, y: source.y });
    out.opacity = opacity;
    if (blendMode !== 'normal') out.blendMode = blendMode;
    for (const key of ['evrName', 'evrClip', 'evrAlphaLock']) if (target.data?.[key] !== undefined) out.data[key] = target.data[key];
    if (target.name) out.name = target.name;
    return out;
  }
  function openVectorFilterPanel(ep) {
    const parts = paintLayer(ep), area = document.querySelector('#entryPainter .canvas_area');
    const target = parts && vectorPrimary(ep, vectorRows(parts.layer))?.item;
    if (!parts || !area) return;
    if (!target) { toast('필터를 걸 레이어를 먼저 고르세요(레이어 창에서 줄을 누르거나 그림을 선택).', 3000); return; }
    if (vectorPicked(ep, vectorRows(parts.layer)).length > 1) { toast('레이어를 하나만 고르세요 — 필터는 한 번에 레이어 하나에 겁니다.', 3000); return; }
    if (!target.visible) { toast('숨긴 레이어에는 필터를 걸 수 없습니다 — 보이게 한 뒤 거세요.', 3000); return; }
    let first;
    try { first = vectorFilteredItem(ep, target, FILTERS[0], Object.fromEntries(FILTERS[0].params.map(param => [param.key, param.value]))); }
    catch (error) { console.warn('[entry-vector-rig] 벡터 필터', error); toast('필터를 열 수 없습니다.', 2500); return; }
    paintStore()?.dispatch({ type: 'SELECT_ITEMS', payload: [] });
    mountFilterUi(ep, area, { kind: 'vector', layer: parts.layer, target, wasVisible: target.visible }, first);
  }
  function showFilterResult(result) {
    const ui = filterUi;
    if (!ui) return;
    ui.result = result;
    if (ui.kind === 'vector') {
      ui.preview?.remove();
      ui.preview = result;
      result.visible = ui.wasVisible;
      ui.target.visible = false;
      ui.target.parent.insertChild(ui.target.index + 1, result);
      ui.ep.project.view.update();
      return;
    }
    ui.layer.removeChildren();
    ui.preview = contentRaster(ui.ep, result);
    ui.layer.addChild(ui.preview);
    ui.ep.project.view.update();
  }
  function previewFilter() {
    const ui = filterUi;
    if (!ui) return;
    let result;
    try {
      result = ui.kind === 'vector' ? vectorFilteredItem(ui.ep, ui.target, ui.filter, ui.params, ui)
        : filteredContent(ui.source, ui.filter, ui.params, !!pixelPen.alphaLock, ui.grid);
    } catch (error) {
      // 앞 미리보기는 그대로 두되 [적용]은 끈다 — 칩은 새 필터로 눌려 있는데 적용하면 앞 필터 결과가 들어갔다(검토 지적)
      console.warn('[entry-vector-rig] 필터 미리보기', error);
      setFilterApplyOk(ui, false);
      toast('이 필터는 이 레이어에 걸 수 없습니다.', 2500);
      return;
    }
    setFilterApplyOk(ui, true);
    showFilterResult(result);
  }
  function setFilterApplyOk(ui, ok) {
    ui.stale = !ok;
    const apply = ui.panel.querySelector('.evr-filter-apply');
    if (apply) apply.disabled = !ok;
  }
  function selectFilter(filter) {
    const ui = filterUi;
    if (!ui) return;
    ui.filter = filter;
    ui.params = Object.fromEntries(filter.params.map(param => [param.key, param.value]));
    renderFilterParams();
    previewFilter();
    // 그림으로 바꾸는 필터는 레이어 뼈대를 옮길 수 없다(뼈대는 도형 모양 기준) — 말없이 사라지지 않게 알린다(검토 지적)
    if (ui.kind === 'vector' && !COLOR_FILTERS.has(filter.id) && ui.target.data?.[BONES]) toast('이 필터는 레이어를 그림으로 바꿔서 뼈대가 빠집니다(적용 뒤 되돌리기로 되돌릴 수 있음).', 4000);
  }
  // 닫기: apply면 결과를 남기고 되돌리기 기록 한 번, 아니면 떼어 둔 원래 항목을 그대로 되돌린다
  function closeFilterPanel(apply) {
    const ui = filterUi;
    if (!ui || (apply && ui.stale)) return; // 계산이 안 된 필터는 적용하지 않는다(창은 그대로)
    filterUi = null;
    if (entryPicker && ui.panel.contains(entryPicker.anchor)) closeEntryPicker();
    ui.panel.remove();
    ui.shade.remove();
    window.removeEventListener('keydown', ui.keys, true);
    if (ui.kind === 'vector') {
      if (!apply || !ui.preview || !ui.preview.isInserted() || !ui.target.isInserted()) {
        ui.preview?.remove();
        if (ui.target.isInserted()) ui.target.visible = ui.wasVisible;
        ui.ep.project.view.update();
        return;
      }
      ui.target.remove(); // 원래 자리(바로 위)에 미리보기 항목이 결과로 남는다
      ui.preview.visible = ui.wasVisible;
      ui.ep.project.view.update();
      if (!saveEntryHistory(ui.ep)) console.warn('[entry-vector-rig] 필터: 되돌리기 기록을 남기지 못함');
      layerUi.vectorEpoch++;
      layerUi.signature = null;
      // 결과 레이어를 골라 둔다(비트맵은 지금 레이어가 그대로 — 예전엔 적용 뒤 선택이 풀려 [필터]가 꺼졌음, 검토 지적)
      layerUi.vectorPick = ui.preview;
      selectVectorUnit(ui.preview);
      refreshLayers(ui.ep);
      return;
    }
    if (!apply || !ui.preview || !ui.result) {
      ui.layer.removeChildren();
      ui.layer.addChildren(ui.original);
      ui.ep.project.view.update();
      return;
    }
    // 적용: 번진 둘레의 투명한 여백은 칸에 맞춰 잘라 낸다(적용할 때마다 그림이 커지지 않게 — 검토 지적). 떼어 둔 항목 중 기준점 상자는
    // 다시 넣는다(상자는 그림이 아니라 필터 대상이 아님 — 빠지면 다음 저장까지 사라졌음, 검토 지적).
    const kept = trimFilterContent(ui.result, ui.grid), stage = paintLayer(ui.ep)?.stage;
    ui.layer.removeChildren();
    // 다 투명해졌으면 작업 영역만 한 빈 그림(엔트리 비트맵 그림 층은 그림 한 장을 기대함)
    if (kept) ui.layer.addChild(contentRaster(ui.ep, kept));
    else if (stage) ui.layer.addChild(contentRaster(ui.ep, { canvas: canvasOfSize(Math.max(1, Math.round(stage.width)), Math.max(1, Math.round(stage.height))), x: Math.round(stage.x), y: Math.round(stage.y) }));
    for (const item of ui.original) if (item.data?.entryVectorCanvasBox === '1') ui.layer.addChild(item);
    ui.ep.project.view.update();
    if (!saveEntryHistory(ui.ep)) console.warn('[entry-vector-rig] 필터: 되돌리기 기록을 남기지 못함');
    layerUi.signature = null;
    refreshLayers(ui.ep);
  }
  function buildFilterPanel(ep) {
    const panel = document.createElement('div');
    panel.className = 'evr-filter-panel';
    const title = document.createElement('b');
    title.className = 'evr-filter-title';
    title.textContent = '필터 — 지금 레이어';
    const chips = document.createElement('div');
    chips.className = 'evr-filter-list';
    for (const filter of FILTERS) {
      chips.append(button(filter.label, () => selectFilter(filter), { class: 'evr-brush-toggle evr-filter-chip', 'data-filter': filter.id }));
    }
    const params = document.createElement('div');
    params.className = 'evr-filter-params';
    const row = document.createElement('div');
    row.className = 'evr-filter-actions';
    row.append(button('적용', () => closeFilterPanel(true), { class: 'evr-layers-act evr-filter-apply' }),
      button('취소', () => closeFilterPanel(false), { class: 'evr-layers-act evr-filter-cancel' }));
    panel.append(title, chips, params, row);
    for (const type of ['mousemove', 'pointermove', 'mousedown', 'pointerdown', 'wheel']) panel.addEventListener(type, event => event.stopPropagation());
    return panel;
  }
  function renderFilterParams() {
    const ui = filterUi;
    if (!ui) return;
    for (const chip of ui.panel.querySelectorAll('.evr-filter-chip')) chip.setAttribute('aria-pressed', String(chip.dataset.filter === ui.filter.id));
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; previewFilter(); }); };
    const box = ui.panel.querySelector('.evr-filter-params');
    if (entryPicker && box.contains(entryPicker.anchor)) closeEntryPicker();
    box.replaceChildren(...ui.filter.params.map(param => {
      const label = document.createElement('label');
      label.className = 'evr-brush-level evr-filter-param';
      label.dataset.key = param.key;
      const text = document.createElement('span');
      text.textContent = param.label;
      if (param.type === 'color') {
        // 색은 엔트리 색 고르기 창으로(그라데이션 끝 색과 같은 칸)
        label.append(text, entryColorField(ui.params[param.key], color => { ui.params[param.key] = color; later(); }, 'evr-filter-color'));
        return label;
      }
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: String(param.min), max: String(param.max), step: '1', value: String(param.value) });
      const value = document.createElement('b');
      value.textContent = `${param.value}${param.unit || ''}`;
      input.addEventListener('input', () => { ui.params[param.key] = Number(input.value); value.textContent = `${input.value}${param.unit || ''}`; later(); });
      label.append(text, input, value);
      return label;
    }));
  }
  // 모양·모드가 바뀌었거나 그림판이 사라지면 필터 창을 닫고 원래대로(미리보기가 다른 모양에 남지 않게)
  function checkFilterPanel(painter) {
    const ui = filterUi;
    if (!ui) return;
    const ep = painter?.entryPaint;
    if (ui.kind === 'vector') {
      // 미리보기나 원래 항목이 다른 길(엔트리 되돌리기 등)로 빠졌거나 모양·모드가 바뀌었으면 취소로 닫는다(빠진 것은 다시 넣지 않음)
      if (ep !== ui.ep || ep?.mode !== 'VECTOR' || painter?.file?.id !== ui.fileId || !ui.target.isInserted() || !ui.preview?.isInserted() || !document.contains(ui.panel)) closeFilterPanel(false);
      return;
    }
    // 미리보기 그림이 다른 길(엔트리 되돌리기 등)로 빠졌으면 원래 항목을 되돌리지 않고 창만 닫는다(겹쳐 넣지 않게)
    if (ui.preview && !ui.preview.isInserted()) { ui.original = null; ui.preview = null; }
    if (!ui.original || ep !== ui.ep || ep?.mode !== 'BITMAP' || painter?.file?.id !== ui.fileId || !ui.layer.isInserted() || !document.contains(ui.panel)) {
      if (!ui.original) { filterUi = null; ui.panel.remove(); ui.shade.remove(); window.removeEventListener('keydown', ui.keys, true); return; }
      closeFilterPanel(false);
    }
  }
  // ---- 비트맵 선택이 반투명 화소를 지우지 않게(1.3) ----
  // 엔트리 비트맵 선택 도구는 고른 부분을 떼어 낼 때(getCutRaster → getAliasingRaster) 화소 투명도를 128 기준으로 0/255로 깎는다
  // (entry-paint 261015 소스 — 확장 없이도 같음: 30%·10% 화소가 박스를 놓는 순간 사라지고 60%는 100%가 됨, 10-18 실험). 엔트리 붓·선은
  // 원래 번짐 없이 그리지만, 흐림 필터·부드러운 붓·불투명도·불러온 그림의 반투명 화소까지 선택 한 번에 망가졌다(사용자 제보 10-18 "필터
  // 적용 뒤 선택 박스 → 필터가 사라짐", 넓혀 본 탐색 95가지 중 흐림+선택 6가지만 실패). 떼어 낼 때 엔트리처럼 같은 해상도로 굽되 깎는
  // 단계만 건너뛴다 — 반투명이 없는 그림(픽셀 아트)은 결과가 같다.
  function ensureSelectKeepsAlpha(painter) {
    const tool = painter?.entryPaint?.paper?.tools?.find(item => item.MY_MODE?.toolMode === 'SELECT' && item.MY_MODE?.graphicsMode === 'BITMAP');
    if (!tool || own(tool, '__evrKeepAlpha') || typeof tool.getCutRaster !== 'function') return;
    Object.defineProperty(tool, '__evrKeepAlpha', { value: true });
    // 엔트리(261015)와 같은 모양일 때만 바꾼다: 떼어 내기 = getSubRaster 뒤 getAliasingRaster, 부르는 쪽 = 같은 사각으로 removeRect.
    // 엔트리가 바뀌었으면 손대지 않는다(엔트리 원래대로 — 검토 지적)
    const cutSource = String(tool.getCutRaster), callerSource = String(tool.constructor);
    if (!/getSubRaster/.test(cutSource) || !/getAliasingRaster/.test(cutSource) ||
      !/getCutRaster\((\w+),(\w+)\)[\s\S]{0,200}removeRect\(\1,\2\.width,\2\.height,\2\.point\)/.test(callerSource)) {
      console.warn('[entry-vector-rig] 엔트리 선택 도구가 예상과 달라 반투명 지키기를 건너뜀');
      return;
    }
    tool.getCutRaster = function (raster, rect) {
      const m = raster.matrix;
      if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9) {
        // 늘리거나 돌리지 않은 그림(평소)은 화소 칸 그대로 떼어 내고 다시 그리지 않는다: 반 화소 자리(홀수 크기 그림을 가운데 둔 때 등)에서
        // 다시 그리면 불투명 가장자리에 반투명 띠가 생겼다(탐침으로 재현 — 엔트리는 깎아서 가리는 대신 불투명 화소 한 줄을 잃음). 반 화소 자리
        // 그림은 먼저 0.5px 옮겨 그림 칸에 맞춘다(놓을 때 엔트리가 굽는 단계가 칸에 맞추며 다시 그려 띠가 생겼음). 엔트리는 이 사각(같은
        // 객체)으로 원래 그림을 지우므로(removeRect) 사각도 같은 화소 칸으로 맞춘다 — 남은 그림과 조각이 화소 단위로 딱 나뉜다.
        const b = raster.bounds, dx = Math.round(b.x) - b.x, dy = Math.round(b.y) - b.y;
        if (dx || dy) raster.translate(dx, dy);
        // 사각은 옮기기 전 그림 기준이라 옮긴 만큼 빼고 맞춘다(예전엔 반 화소 그림에서 선택 상자가 끈 자리보다 1px 오른쪽·아래 — 검토 L)
        const x0 = Math.round(rect.x - dx), y0 = Math.round(rect.y - dy);
        const w = Math.max(1, Math.round(rect.x + rect.width - dx) - x0), h = Math.max(1, Math.round(rect.y + rect.height - dy) - y0);
        rect.x = x0; rect.y = y0; rect.width = w; rect.height = h;
        const piece = raster.getSubRaster(x0, y0, w, h);
        piece.remove();
        return piece;
      }
      const piece = raster.getSubRaster(rect);
      piece.remove();
      return piece.rasterize({ resolution: 72, insert: false });
    };
  }
  // ---- 영역 채우기(벡터·비트맵) ----
  // 엔트리 채우기(entry-paint 260921)는 벡터에서는 누른 도형 하나의 색만 바꿔 선으로 둘러싼 빈 곳은 못 채우고, 비트맵에서는
  // 똑같은 색(허용 오차 없음)이 이어진 곳만 채워 선 사이 틈으로 새어 나간다. 켜 두면 이비스페인트 버킷처럼 보이는 그림 전체를
  // 기준으로 누른 곳과 비슷한 색이 이어진 영역을 찾아, 선 쪽으로 1.5px(이비스 "확장" 기본값) 넓혀 선 아래에 채운다.
  // 틈 막기: 경계(누른 곳 색과 다른 화소)를 모폴로지 닫힘(원판 반지름 = 틈 막기, 팽창 뒤 침식)으로 이어 붙인 뒤 채운다.
  // 반지름의 두 배보다 좁은 틈이 막힌다. 거리는 Felzenszwalb·Huttenlocher(2012) 거리 변환으로 잰다. 벡터 결과는
  // d3-contour(마칭 스퀘어)로 영역 윤곽을 따 경로로 만든다. 되돌리기 기록은 엔트리 채우기의 누르기 처리가 그대로 남긴다.
  // 단위는 그림 px(벡터는 그림 좌표, 비트맵은 그림 화소)라 확대해도 결과가 같다.
  const regionFill = { on: true, gap: 4 };
  const FILL_GAP_MAX = 12;
  const FILL_EXPAND = 1.5;
  const FILL_TOLERANCE = 32; // 0~255. 누른 곳 색과 이보다 더 다르면 경계(미리 곱한 RGBA의 가장 큰 차이)
  const FILL_MAX_PIXELS = 4e6; // 벡터 기준 그림 화소 수 상한(확대가 커도 이 안에서 해상도를 정함)
  // Felzenszwalb·Huttenlocher 1차원 제곱 거리 변환(아래 포락선)
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  // feature(1)인 화소까지 거리의 제곱
  function distanceSq(feature, w, h) {
    const out = new Float64Array(w * h), n = Math.max(w, h);
    for (let i = 0; i < w * h; i++) out[i] = feature[i] ? 0 : 1e20;
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = out[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0, row = 0; y < h; y++, row += w) {
      for (let x = 0; x < w; x++) f[x] = out[row + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[row + x] = d[x];
    }
    return out;
  }
  const withinSq = (dist, r) => {
    const out = new Uint8Array(dist.length), r2 = r * r;
    for (let i = 0; i < dist.length; i++) out[i] = dist[i] <= r2 ? 1 : 0;
    return out;
  };
  // 모폴로지 닫힘: 반지름 r 원판으로 팽창한 뒤 침식
  function closeMask(mask, w, h, r) {
    const grown = withinSq(distanceSq(mask, w, h), r), outside = new Uint8Array(grown.length);
    for (let i = 0; i < grown.length; i++) outside[i] = 1 - grown[i];
    const away = distanceSq(outside, w, h), r2 = r * r, closed = new Uint8Array(grown.length);
    for (let i = 0; i < grown.length; i++) closed[i] = mask[i] || (grown[i] && away[i] > r2) ? 1 : 0;
    return closed;
  }
  // 4방향으로 이어진 칸 채우기
  function floodFrom(block, w, h, sx, sy) {
    const out = new Uint8Array(w * h), start = sy * w + sx;
    if (block[start]) return null;
    const stack = [start];
    out[start] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      if (x > 0 && !out[i - 1] && !block[i - 1]) { out[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !out[i + 1] && !block[i + 1]) { out[i + 1] = 1; stack.push(i + 1); }
      if (i >= w && !out[i - w] && !block[i - w]) { out[i - w] = 1; stack.push(i - w); }
      if (i + w < out.length && !out[i + w] && !block[i + w]) { out[i + w] = 1; stack.push(i + w); }
    }
    return out;
  }
  // RGBA 화소(미리 곱하지 않은 값)에서 (sx, sy)를 누른 영역. gap·expand는 화소 단위.
  function fillRegion(data, w, h, sx, sy, gap, expand) {
    const s = (sy * w + sx) * 4, sa = data[s + 3] / 255;
    const seed = [data[s] * sa, data[s + 1] * sa, data[s + 2] * sa, data[s + 3]];
    const barrier = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < barrier.length; i++, p += 4) {
      const a = data[p + 3] / 255;
      const diff = Math.max(Math.abs(data[p] * a - seed[0]), Math.abs(data[p + 1] * a - seed[1]),
        Math.abs(data[p + 2] * a - seed[2]), Math.abs(data[p + 3] - seed[3]));
      barrier[i] = diff > FILL_TOLERANCE ? 1 : 0;
    }
    // 틈 막기로 누른 곳까지 막히면(틈보다 좁은 칸을 누름) 막지 않고 채운다
    let region = gap >= 1 ? floodFrom(closeMask(barrier, w, h, gap), w, h, sx, sy) : null;
    region ||= floodFrom(barrier, w, h, sx, sy);
    if (region && expand > 0) region = withinSq(distanceSq(region, w, h), expand);
    return region;
  }
  function fillColorOf(paper, value) {
    const color = new paper.Color(value || '#000000');
    return [color.red * 255, color.green * 255, color.blue * 255, (color.alpha ?? 1) * 255];
  }
  // ---- 엔트리 색 고르기 다시 쓰기(1.3, 사용자 요청 "우리가 따로 색을 고르게 한 거를 엔트리 css로 재사용") ----
  // 확장이 따로 둔 색 칸(그라데이션 끝 색, 필터 외곽선·그림자 색)은 브라우저 기본 색 칸 대신 엔트리 그림판 색 칸과 같은 모양으로 그리고,
  // 누르면 엔트리 색 고르기 창(EntryTool.ColorPicker — 엔트리 그림판 채우기·윤곽선 색이 띄우는 것과 같은 부품, 10-18 실험)을 띄운다.
  // 색 칸 모양은 그림판 아래 막대의 ColorBox를 복제한다(엔트리 styled-components 이름은 빌드마다 바뀌어 직접 쓰지 않음). 아직 못 봤으면
  // 확장 칸으로 대신한다. 창 밖을 누르면 닫는다(필터 덮개가 누르기를 막아 엔트리 바깥 누르기 감지가 못 받으므로 캡처 단계에서 직접 봄).
  let colorBoxTemplate = null, entryPicker = null;
  function rememberColorBox() {
    if (!colorBoxTemplate) {
      const box = document.querySelector('#entryPainter .bottom_area .ColorBox');
      if (box?.querySelector('.color')) colorBoxTemplate = box.cloneNode(true);
    }
    return colorBoxTemplate;
  }
  // 엔트리 색 고르기가 주는 값을 #rrggbb로(캔버스 fillStyle 표준 변환 — 불투명 색만 #으로 나옴, 투명은 버림). 캔버스는 읽을 수 없는 값을
  // 말없이 무시하므로 서로 다른 두 시작값으로 넣어 보고 같을 때만 쓴다(검토 지적: 예전엔 잘못된 값이 검정이 됨)
  function cssHex(value) {
    if (typeof value !== 'string' || !value) return null;
    const ctx = canvasOfSize(1, 1).getContext('2d');
    const read = start => { ctx.fillStyle = start; ctx.fillStyle = value; return ctx.fillStyle; };
    const a = read('#000000'), b = read('#ffffff');
    return a === b && /^#[0-9a-f]{6}$/i.test(a) ? a.toLowerCase() : null;
  }
  function entryColorField(value, onPick, className) {
    const field = document.createElement('button');
    field.type = 'button';
    field.className = `evr-color-field ${className || ''}`.trim();
    field.setAttribute('aria-expanded', 'false');
    const template = rememberColorBox();
    const face = template ? template.cloneNode(true) : document.createElement('span');
    if (!template) face.className = 'evr-color-face';
    face.querySelector('.color')?.classList.remove('multi');
    field.dataset.entryLook = String(!!template);
    field.append(face);
    field.setColor = color => {
      if (field.dataset.color === color) return;
      field.dataset.color = color;
      (face.querySelector('.color') || face).style.background = color;
    };
    field.setColor(value);
    field.addEventListener('click', () => {
      // 열린 고르기 창이 이 칸 것이면 닫기만(엔트리 창이 스스로 숨었으면 다시 연다 — 검토 지적: 두 번 눌러야 열림)
      const shown = entryPicker?.picker && (typeof entryPicker.picker.isShow === 'function' ? entryPicker.picker.isShow() : entryPicker.picker.isShow);
      if (entryPicker?.anchor === field && shown !== false) { closeEntryPicker(); return; }
      openEntryPicker(field, field.dataset.color, color => { field.setColor(color); onPick(color); });
    });
    return field;
  }
  function openEntryPicker(anchor, color, onPick) {
    closeEntryPicker();
    if (typeof window.EntryTool?.ColorPicker !== 'function') { nativeColorPicker(anchor, color, onPick, '엔트리 색 고르기 창을 찾지 못해 브라우저 색 고르기로 엽니다.'); return; }
    const container = document.createElement('div');
    container.className = 'evr-entry-picker';
    // 숫자 칸 입력(방향키·지우기·Ctrl+Z 등)은 칸 안에서만 — 그림판 단축키(도형 지우기·되돌리기)로 가지 않게. Esc = 고르기 창만 닫기
    container.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') closeEntryPicker(); });
    document.body.append(container);
    const state = { anchor, container, picker: null };
    state.outside = event => { if (!container.contains(event.target) && !anchor.contains(event.target)) closeEntryPicker(); };
    window.addEventListener('pointerdown', state.outside, true);
    entryPicker = state;
    anchor.setAttribute('aria-expanded', 'true');
    try {
      state.picker = new window.EntryTool.ColorPicker({ data: { color, positionDom: anchor, canTransparent: false, outsideExcludeDom: [anchor],
        onOutsideClick: () => { if (entryPicker === state) closeEntryPicker(); } }, container });
      state.picker.on('change', next => { const hex = cssHex(next); if (hex && entryPicker === state) onPick(hex); });
    } catch (error) {
      console.warn('[entry-vector-rig] 엔트리 색 고르기 창 열기 실패', error);
      closeEntryPicker();
      nativeColorPicker(anchor, color, onPick, '엔트리 색 고르기 창을 열지 못해 브라우저 색 고르기로 엽니다.');
    }
  }
  // 엔트리 고르기 창을 쓸 수 없을 때(엔트리가 바뀜 등) 색을 바꿀 길이 없어지지 않게 브라우저 기본 색 고르기로 대신한다(검토 지적)
  function nativeColorPicker(anchor, color, onPick, message) {
    toast(message, 4000);
    document.querySelectorAll('.evr-native-color').forEach(old => old.remove()); // 고르기 창은 초점을 안 줘 blur가 안 올 수 있음 — 쌓이지 않게
    const input = Object.assign(document.createElement('input'), { type: 'color', value: cssHex(color) || '#000000' });
    input.className = 'evr-native-color';
    anchor.after(input);
    input.addEventListener('input', () => onPick(input.value.toLowerCase()));
    input.addEventListener('change', () => input.remove());
    input.addEventListener('blur', () => setTimeout(() => input.remove(), 0));
    try { input.showPicker(); } catch { input.click(); }
  }
  function closeEntryPicker() {
    const state = entryPicker;
    if (!state) return;
    entryPicker = null;
    window.removeEventListener('pointerdown', state.outside, true);
    try { state.picker?.hide?.(); state.picker?.remove?.(); } catch (error) { console.warn('[entry-vector-rig] 엔트리 색 고르기 창 닫기', error); }
    state.container.remove();
    state.anchor.setAttribute('aria-expanded', 'false');
  }
  // 색 칸이 화면에서 빠졌으면(도구 바꿈·창 닫힘) 고르기 창도 닫는다
  function checkEntryPicker() {
    rememberColorBox();
    if (entryPicker && !entryPicker.anchor.isConnected) closeEntryPicker();
  }
  // ---- 그라데이션 도구(1.3, 사용자 요청 10-18 "영역 채우기 안에 그라데이션 하지 말고, 따로 별도의 도구로") ----
  // 엔트리 도구 막대 [채우기] 바로 아래에 엔트리 단추와 같은 모양(같은 클래스, 40×40 아이콘, 엔트리 아이콘 색 규칙 — 보통 회색 #979797,
  // 고르면 파랑 #4F80FF + 주황 #FFB500)의 [그라데이션]을 둔다. 누르면 엔트리 채우기 도구를 고르고(시작 색 = 엔트리 채우기 색, 되돌리기·
  // 저장은 엔트리 채우기 그대로) 선으로 둘러싼 곳을 누른 채 끌어 그라데이션으로 칠한다(끌지 않고 누르면 한 색). 엔트리는 채우기를 고른
  // 것으로 알고 있으므로 단추 표시만 바꾼다(그라데이션 = 고름, 채우기 = 안 고름). 엔트리 도구 단추(채우기 포함)를 누르거나 채우기가 아닌
  // 도구가 되면 그라데이션 도구는 꺼진다. 고름/안 고름 클래스는 엔트리 단추에서 읽는다(styled-components 이름은 빌드마다 바뀜).
  const gradientIcon = on => {
    const line = on ? '#4F80FF' : '#979797', from = on ? '#FFB500' : '#979797';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0">' +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="#FFF"/></linearGradient></defs><g fill="none" fill-rule="nonzero">` +
      `<rect x="8.75" y="8.75" width="22.5" height="15.5" rx="2" fill="url(#g)" stroke="${line}" stroke-width="1.5"/>` +
      `<path stroke="${line}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M11 30.5h17m-3-3l3 3-3 3"/></g></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  };
  const toolLook = { on: null, off: null };
  let gradientToolHooked = false;
  const entryToolButtons = () => [...document.querySelectorAll('#entryPainter .ToolButtonWrapper')].filter(button => !button.classList.contains('evr-grad-tool'));
  function ensureGradientTool() {
    const buttons = entryToolButtons(), fill = buttons.find(button => button.innerText.trim() === '채우기');
    let mine = document.querySelector('#entryPainter .evr-grad-tool');
    if (!fill) { mine?.remove(); return; }
    // 엔트리 단추 클래스: 많은 쪽 = 안 고름, 하나뿐인 쪽 = 고름
    const counts = new Map();
    for (const button of buttons) counts.set(button.className, (counts.get(button.className) || 0) + 1);
    if (counts.size === 2) {
      const [a, b] = [...counts.entries()].sort((x, y) => y[1] - x[1]);
      toolLook.off = a[0];
      toolLook.on = b[0];
    } else if (counts.size === 1 && !toolLook.off) toolLook.off = [...counts.keys()][0];
    if (!mine) {
      mine = document.createElement('span');
      mine.className = `${toolLook.off || 'ToolButtonWrapper'} evr-grad-tool`; // 표시는 syncGradientTool이 맞춤(찾는 표시 evr-grad-tool은 처음부터)
      mine.setAttribute('role', 'button');
      mine.title = '확장: 누른 채 끌면 그 방향으로 그라데이션(Shift = 15° 단위) — 비트맵은 지금 레이어 전체, 벡터는 누른 도형(빈 곳은 칠하지 않음). 시작 색은 엔트리 채우기 색, 끝 색·종류·단계는 그라데이션 창';
      const img = Object.assign(document.createElement('img'), { alt: '그라데이션', draggable: false });
      mine.append(img, document.createElement('br'), document.createTextNode('그라데이션'));
      mine.addEventListener('click', () => {
        const button = entryToolButtons().find(item => item.innerText.trim() === '채우기');
        if (!button) return;
        if (!gradientFill.on) cancelGradientDrag();
        window.Entry?.playground?.painter?.entryPaint?.paper?.tools?.forEach(item => item.__evrClearHover?.()); // 엔트리 채우기 마우스 올림 미리 칠하기 지우기(검토 L)
        button.click(); // 엔트리 채우기 도구 고르기(엔트리 단추 누르기 — 아래 캡처에서 그라데이션을 끄므로 그 뒤에 켠다)
        gradientFill.on = true;
        syncGradientTool();
        // 엔트리가 채우기 도구로 바꾼 뒤에 옵션 줄·창을 맞춘다(바꾸기 전에 맞추면 '채우기가 아님'으로 보고 그라데이션을 끔)
        setTimeout(() => {
          try { ensureFillOptions(window.Entry?.playground?.painter); } catch (error) { console.warn('[entry-vector-rig] 그라데이션 도구', error); }
          syncGradientTool();
        }, 0);
      });
    }
    if (mine.previousElementSibling !== fill) fill.after(mine);
    if (!gradientToolHooked) {
      gradientToolHooked = true;
      // 엔트리 도구 단추를 누르면(채우기 포함) 그라데이션 도구를 끈다
      document.addEventListener('click', event => {
        const button = event.target.closest?.('#entryPainter .ToolButtonWrapper');
        if (!button || button.classList.contains('evr-grad-tool') || !gradientFill.on) return;
        gradientFill.on = false;
        cancelGradientDrag();
        setTimeout(() => {
          try { ensureFillOptions(window.Entry?.playground?.painter); } catch (error) { console.warn('[entry-vector-rig] 그라데이션 도구', error); }
          syncGradientTool();
        }, 0);
      }, true);
    }
    syncGradientTool();
  }
  function syncGradientTool() {
    const mine = document.querySelector('#entryPainter .evr-grad-tool');
    const fill = entryToolButtons().find(button => button.innerText.trim() === '채우기');
    if (!mine || !fill || !toolLook.off) return;
    const isFill = window.Entry?.playground?.painter?.entryPaint?.paper?.tool?.MY_MODE?.toolMode === 'FILL';
    const on = gradientFill.on && isFill;
    const cls = `${on && toolLook.on ? toolLook.on : toolLook.off} evr-grad-tool`;
    if (mine.className !== cls) mine.className = cls;
    const img = mine.querySelector('img'), src = gradientIcon(on);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    mine.setAttribute('aria-pressed', String(on));
    // 엔트리 채우기 단추: 그라데이션일 때는 안 고름으로 보이게, 아니면 엔트리가 정한 대로. 되돌릴 때는 우리가 써 둔 글자가 그대로일 때만,
    // 엔트리 상태(저장소의 도구)가 채우기면 원래 글자로(엔트리는 도구가 바뀔 때만 단추를 다시 그려 우리 글자가 남을 수 있음 — 검토 지적)
    const entryFill = () => (paintStore()?.getState?.()?.tool?.toolMode ?? window.Entry?.playground?.painter?.entryPaint?.paper?.tool?.MY_MODE?.toolMode) === 'FILL';
    if (on && fill.className !== toolLook.off) { fill.dataset.evrLook = fill.className; fill.dataset.evrSet = toolLook.off; fill.className = toolLook.off; }
    else if (!on && fill.dataset.evrLook) {
      if (entryFill() && fill.className === fill.dataset.evrSet) fill.className = fill.dataset.evrLook;
      delete fill.dataset.evrLook;
      delete fill.dataset.evrSet;
    }
    // 엔트리는 고른 도구의 아이콘도 색 아이콘으로 바꾼다 — 그라데이션일 때는 [채우기]를 회색 아이콘으로(사용자: "채우기 아이콘도 골라진 듯").
    // 회색 아이콘은 엔트리가 안 고른 채우기에 쓰는 그림을 배워 두고, 아직 못 봤으면 색 아이콘의 파랑·주황을 엔트리 회색으로 바꿔 만든다
    const fillImg = fill.querySelector('img');
    if (fillImg) {
      // 배운 회색 아이콘은 모드(벡터·비트맵)마다 따로 둔다(모드마다 아이콘이 다를 수 있음 — 검토 지적)
      const mode = window.Entry?.playground?.painter?.entryPaint?.mode || '';
      toolLook.fillIconOff ||= {};
      if (!on && !fill.dataset.evrIcon && fill.className === toolLook.off) toolLook.fillIconOff[mode] = fillImg.getAttribute('src');
      if (on) {
        const gray = toolLook.fillIconOff[mode] || grayToolIcon(fillImg.getAttribute('src'));
        if (fillImg.getAttribute('src') !== gray) { fill.dataset.evrIcon = fillImg.getAttribute('src'); fill.dataset.evrIconSet = gray; fillImg.setAttribute('src', gray); }
      } else if (fill.dataset.evrIcon) {
        if (entryFill() && fillImg.getAttribute('src') === fill.dataset.evrIconSet) fillImg.setAttribute('src', fill.dataset.evrIcon);
        delete fill.dataset.evrIcon;
        delete fill.dataset.evrIconSet;
      }
    }
    // 아래 막대 왼쪽 도구 이름(엔트리 ToolTitleComp — 엔트리는 채우기로 알고 있어 '채우기')도 그라데이션으로(사용자: "아래 막대가 '채우기'").
    // 엔트리가 도구를 바꾸며 다시 그릴 때 꼬이지 않게 글자 칸은 바꿔 끼우지 않고 안의 글자·그림만 고친다
    const title = document.querySelector('#entryPainter .ToolTitleComp');
    const titleImg = title?.querySelector('img'), titleText = title && [...title.querySelectorAll('div')].map(div => div.firstChild).find(node => node?.nodeType === 3);
    if (titleImg && titleText) {
      const icon = gradientIcon(true);
      if (on && titleText.nodeValue !== '그라데이션') {
        title.dataset.evrText = titleText.nodeValue; title.dataset.evrIcon = titleImg.getAttribute('src');
        titleText.nodeValue = '그라데이션'; titleImg.setAttribute('src', icon);
      } else if (!on && title.dataset.evrText) {
        if (titleText.nodeValue === '그라데이션') titleText.nodeValue = title.dataset.evrText;
        if (titleImg.getAttribute('src') === icon) titleImg.setAttribute('src', title.dataset.evrIcon);
        delete title.dataset.evrText;
        delete title.dataset.evrIcon;
      }
    }
  }
  // 엔트리 고른 도구 아이콘(파랑 #4F80FF·주황 #FFB500)을 안 고른 아이콘 색(회색 #979797)으로
  function grayToolIcon(src) {
    try {
      const [head, body] = String(src).split(',');
      if (!/base64/.test(head)) return src;
      return `${head},${btoa(atob(body).replace(/#4F80FF|#FFB500/gi, '#979797'))}`;
    } catch { return src; }
  }
  // ---- 그라데이션 창(1.3, 사용자 요청 "그라데이션은 따로 창으로"): 그라데이션 도구를 고르면 그림 칸 오른쪽 아래에 뜬다. 종류·끝 색·
  // 끝 투명·단계를 여기서 고르고, 머리를 끌어 옮긴다(옮긴 자리는 이 페이지 동안 기억). [×] = 그라데이션 도구 끄기(채우기로).
  let gradientWinPos = null;
  function ensureGradientWindow(show) {
    const area = document.querySelector('#entryPainter .canvas_area');
    let win = document.querySelector('#entryPainter .evr-grad-win');
    if (!show || !area) {
      if (win) { if (entryPicker && win.contains(entryPicker.anchor)) closeEntryPicker(); win.remove(); }
      return;
    }
    if (!win) win = buildGradientWindow();
    if (win.parentElement !== area) area.append(win);
    placeGradientWindow(win);
    syncGradientWindow(win);
  }
  function placeGradientWindow(win) {
    const area = win.parentElement;
    if (!gradientWinPos || !area) return;
    const x = Math.round(Math.max(0, Math.min(gradientWinPos.x, area.clientWidth - win.offsetWidth)));
    const y = Math.round(Math.max(0, Math.min(gradientWinPos.y, area.clientHeight - win.offsetHeight)));
    if (win.style.left !== `${x}px` || win.style.top !== `${y}px`) Object.assign(win.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  }
  function buildGradientWindow() {
    const win = document.createElement('div');
    win.className = 'evr-grad-win';
    const head = document.createElement('div');
    head.className = 'evr-grad-win-head';
    head.title = '끌어서 창 옮기기';
    const title = document.createElement('span');
    title.className = 'evr-grad-win-title';
    title.textContent = '그라데이션';
    const close = button('×', () => {
      gradientFill.on = false;
      cancelGradientDrag();
      const box = document.querySelector('#entryPainter .evr-fill-opts');
      if (box) syncFillOptions(box); else ensureGradientWindow(false);
      syncGradientTool();
    }, { class: 'evr-grad-win-close', title: '그라데이션 도구 끄기(채우기로)', 'aria-label': '그라데이션 도구 끄기' });
    head.append(title, close);
    head.addEventListener('pointerdown', event => {
      const area = win.parentElement;
      if (event.button !== 0 || event.target.closest('button') || !area) return;
      event.preventDefault();
      const a = area.getBoundingClientRect(), r = win.getBoundingClientRect(), dx = event.clientX - r.left, dy = event.clientY - r.top;
      head.setPointerCapture(event.pointerId);
      const move = e => { gradientWinPos = { x: e.clientX - a.left - dx, y: e.clientY - a.top - dy }; placeGradientWindow(win); };
      const stop = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', stop);
        head.removeEventListener('pointercancel', stop);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', stop);
      head.addEventListener('pointercancel', stop);
    });
    const sync = () => syncGradientWindow(win);
    const kind = button('직선', () => { gradientFill.radial = !gradientFill.radial; sync(); },
      { class: 'evr-brush-toggle evr-grad-kind', title: '직선: 누른 곳에서 놓은 곳 방향으로 / 원형: 누른 곳이 가운데, 놓은 곳까지가 반지름' });
    const endWrap = document.createElement('label');
    endWrap.className = 'evr-brush-level evr-grad-endwrap';
    endWrap.title = '끝 색(시작 색은 엔트리 채우기 색)';
    const endText = document.createElement('span');
    endText.textContent = '끝 색';
    const end = entryColorField(gradientFill.end, color => { gradientFill.end = color; gradientFill.endClear = false; sync(); }, 'evr-grad-end');
    endWrap.append(endText, end);
    const clear = button('끝 투명', () => { gradientFill.endClear = !gradientFill.endClear; sync(); },
      { class: 'evr-brush-toggle evr-grad-clear', title: '끝을 투명하게(시작 색이 점점 사라짐)' });
    const stepsWrap = document.createElement('label');
    stepsWrap.className = 'evr-brush-level evr-grad-steps';
    stepsWrap.title = '단계: 매끈하게 이어지는 대신 2~8단계 색 띠로 끊어 칠함(픽셀 아트)';
    const stepsText = document.createElement('span');
    stepsText.textContent = '단계';
    const steps = document.createElement('input');
    Object.assign(steps, { type: 'range', min: '1', max: String(GRADIENT_STEPS_MAX), step: '1' });
    steps.className = 'evr-grad-steps-range';
    steps.addEventListener('input', () => { gradientFill.steps = Number(steps.value); sync(); });
    steps.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        event.stopPropagation();
    });
    const stepsValue = document.createElement('b');
    stepsValue.className = 'evr-grad-steps-value';
    stepsWrap.append(stepsText, steps, stepsValue);
    const row = (...children) => { const div = document.createElement('div'); div.className = 'evr-grad-win-row'; div.append(...children); return div; };
    win.append(head, row(kind), row(endWrap, clear), row(stepsWrap));
    return win;
  }
  function syncGradientWindow(win) {
    const kind = win.querySelector('.evr-grad-kind'), kindText = gradientFill.radial ? '원형' : '직선';
    if (kind.textContent !== kindText) kind.textContent = kindText;
    const clear = win.querySelector('.evr-grad-clear');
    if (clear.getAttribute('aria-pressed') !== String(gradientFill.endClear)) clear.setAttribute('aria-pressed', String(gradientFill.endClear));
    const end = win.querySelector('.evr-grad-end');
    end.setColor(gradientFill.end);
    if (end.dataset.off !== String(gradientFill.endClear)) end.dataset.off = String(gradientFill.endClear);
    const steps = win.querySelector('.evr-grad-steps-range');
    if (Number(steps.value) !== gradientFill.steps) steps.value = String(gradientFill.steps);
    const stepsValue = win.querySelector('.evr-grad-steps-value'), stepsText = gradientFill.steps < 2 ? '매끈' : `${gradientFill.steps}`;
    if (stepsValue.textContent !== stepsText) stepsValue.textContent = stepsText;
  }
  // ---- 그라데이션 채우기(1.3, 사용자 요청 3명) ----
  // 그라데이션 도구에서 누른 채 끌어 방향을 정한다(포토샵·크리타 그라데이션 도구와 같은 끌기, Shift = 15° 단위). 칠하는 범위는 포토샵·
  // 일러스트레이터 방식(사용자 결정 10-18 — 선으로 둘러싼 곳만 칠하니 "달고나 틀로 잘라 낸 것처럼 잘린다"): 비트맵 = 지금 레이어 전체(작업
  // 영역)에 덮어 칠함(투명 잠금이면 칠해진 화소의 색만), 벡터 = 누른 도형의 칠 전체(도형 모양 그대로), 빈 곳이면 그림 칸 크기 사각형을 맨
  // 아래(배경)에 — 맨 위면 그림을 다 덮으므로(내 결정). 끌지 않고 누르면 아무것도 안 한다. 시작 색 = 엔트리 채우기 색, 끝 색 = 확장 끝 색(투명이면 시작 색을
  // 투명하게 — 캔버스 그라데이션은 미리 곱하지 않은 색으로 섞여 흰 투명으로 가면 중간이 뿌옇게 됨). 색 계산은 표준 그대로: 벡터 = paper
  // 그라데이션(저장 SVG linear/radialGradient), 비트맵 = 캔버스 createLinearGradient/createRadialGradient. 단계(2~8, 픽셀 아트):
  // 같은 위치에 색 정지점을 두 개씩 둬 띠로 끊는다. 원형은 누른 곳이 가운데, 놓은 곳까지가 반지름.
  const gradientFill = { on: false, radial: false, end: '#ffffff', endClear: false, steps: 1 };
  const GRADIENT_STEPS_MAX = 8;
  const GRADIENT_DRAG_MIN = 4; // 화면 px — 이보다 덜 끌면 칠하지 않음
  let gradientDrag = null; // { tool, event(누른 곳), end }
  function gradientStops(paper, startValue) {
    const a = new paper.Color(startValue || '#000000');
    const b = gradientFill.endClear ? a.clone() : new paper.Color(gradientFill.end);
    if (gradientFill.endClear) b.alpha = 0;
    const n = gradientFill.steps;
    if (n < 2) return [[a, 0], [b, 1]];
    const mix = t => new paper.Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t,
      (a.alpha ?? 1) + ((b.alpha ?? 1) - (a.alpha ?? 1)) * t);
    const stops = [];
    for (let i = 0; i < n; i++) { const color = mix(i / (n - 1)); stops.push([color, i / n], [color.clone(), (i + 1) / n]); }
    return stops;
  }
  function gradientPaperColor(paper, startValue, start, end) {
    return new paper.Color({ gradient: { stops: gradientStops(paper, startValue).map(([color, offset]) => new paper.GradientStop(color, offset)),
      radial: gradientFill.radial }, origin: start, destination: end });
  }
  // 비트맵: 그림 화소 좌표의 시작·끝으로 그림 크기 그라데이션 화소(RGBA, 미리 곱하지 않음)
  function gradientPixels(paper, startValue, w, h, s, e) {
    const ctx = canvasOfSize(w, h).getContext('2d', { willReadFrequently: true });
    const g = gradientFill.radial ? ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, Math.max(1e-6, s.getDistance(e)))
      : ctx.createLinearGradient(s.x, s.y, e.x, e.y);
    for (const [color, offset] of gradientStops(paper, startValue)) g.addColorStop(Math.min(1, Math.max(0, offset)), color.toCSS(false));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }
  // Shift: 시작점에서 15° 단위 방향으로
  function gradientEnd(start, point, shift) {
    if (!shift) return point;
    const v = point.subtract(start), step = Math.PI / 12, angle = Math.round(Math.atan2(v.y, v.x) / step) * step;
    return start.add(new start.constructor(Math.cos(angle) * v.length, Math.sin(angle) * v.length));
  }
  // 끄는 동안 화면 위 방향선(그림 층에는 아무것도 넣지 않아 저장·되돌리기에 섞이지 않음)
  function showGradientGuide(ep, start, end) {
    const view = ep.project.view, canvas = view.element, rect = canvas.getBoundingClientRect();
    const k = rect.width / view.viewSize.width, a = view.projectToView(start).multiply(k), b = view.projectToView(end).multiply(k);
    const NS = 'http://www.w3.org/2000/svg';
    let svg = document.querySelector('.evr-grad-guide');
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'evr-grad-guide');
      for (const tag of ['line', 'circle', 'circle']) svg.append(document.createElementNS(NS, tag));
      document.body.append(svg);
    }
    Object.assign(svg.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const [line, dot, ring] = svg.children;
    for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })) line.setAttribute(key, value);
    for (const [key, value] of Object.entries({ cx: a.x, cy: a.y, r: 4 })) dot.setAttribute(key, value);
    for (const [key, value] of Object.entries({ cx: a.x, cy: a.y, r: gradientFill.radial ? a.getDistance(b) : 0 })) ring.setAttribute(key, value);
  }
  function hideGradientGuide() { document.querySelector('.evr-grad-guide')?.remove(); }
  function cancelGradientDrag() { gradientDrag = null; hideGradientGuide(); }
  // 벡터: 그림 레이어 전체를 무대 크기 그림으로 그려 영역을 찾고, 윤곽을 경로로 만들어 누른 곳의 도형 바로 위(그 위 선들 아래)에 넣는다.
  function vectorRegionFill(ep, tool, event) {
    const found = paintLayer(ep);
    if (!found?.stage || !window.__evrD3Contour) return false;
    const { layer, stage } = found, paper = ep.paper, view = ep.project.view;
    const s = Math.max(.25, Math.min(Math.max(1, view.zoom), Math.sqrt(FILL_MAX_PIXELS / (stage.width * stage.height))));
    const w = Math.ceil(stage.width * s), h = Math.ceil(stage.height * s);
    const sx = Math.floor((event.point.x - stage.left) * s), sy = Math.floor((event.point.y - stage.top) * s);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const guides = layer.getItems({ match: item => item.visible && item.data?.guideItem });
    guides.forEach(item => { item.visible = false; });
    let raster = null;
    try { if (layer.children.length) raster = ownRasterize(layer, { resolution: 72 * s, insert: false }); }
    finally { guides.forEach(item => { item.visible = true; }); }
    if (raster?.canvas && raster.bounds.width > 0 && raster.bounds.height > 0)
      ctx.drawImage(raster.canvas, (raster.bounds.left - stage.left) * s, (raster.bounds.top - stage.top) * s,
        raster.bounds.width * s, raster.bounds.height * s);
    const region = fillRegion(ctx.getImageData(0, 0, w, h).data, w, h, sx, sy, regionFill.gap * s, FILL_EXPAND * s);
    if (!region) return false;
    const values = new Float64Array(region);
    const shape = window.__evrD3Contour.contours().size([w, h]).thresholds([.5])(values)[0];
    const rings = (shape?.coordinates || []).flat().filter(ring => ring.length >= 4);
    if (!rings.length) return false;
    const paths = rings.map(ring => {
      const raw = new paper.Path({ segments: ring.map(([x, y]) => [stage.left + x / s, stage.top + y / s]), closed: true, insert: false });
      if (raw.segments.length <= 8) return raw;
      const fit = raw.clone({ insert: false });
      fit.simplify(.8 / s); // 화소 계단만 펴는 정도(그림 화소의 0.8)
      return fit.getIntersections().length ? raw : fit;
    });
    const item = paths.length === 1 ? paths[0] : new paper.CompoundPath({ children: paths, insert: false });
    item.fillColor = new paper.Color(tool.fillColor || '#000000');
    item.strokeColor = null;
    // 누른 곳에 칠해져 있던 가장 위 도형 바로 위에 둔다(그보다 위의 선은 그대로 위에). 빈 곳이면 맨 아래.
    const hit = layer.hitTest(event.point, { fill: true, stroke: true, segments: false, tolerance: 0,
      match: result => !result.item.data?.guideItem });
    const under = hit?.item;
    if (under && under.parent) {
      if (under.parent !== layer) item.transform(under.parent.globalMatrix.inverted());
      item.insertAbove(under);
    } else layer.insertChild(0, item);
    return true;
  }
  const FILL_SKIP = Symbol('채우지 않음');
  // 비트맵: 그림(래스터) 화소에서 바로 영역을 찾아, 이미 있는 화소 아래로(destination-over) 칠한다.
  function bitmapRegionFill(ep, tool, event) {
    const parts = paintLayer(ep);
    let raster = parts?.layer.children[0];
    if (!(raster instanceof ep.paper.Raster) || !raster.width || !raster.height) return null;
    // 캔버스를 키우면 그림(엔트리가 만든 무대 크기·불러온 그림 크기)보다 칸이 넓다. 그림 밖 칸을 누르면 그림을 칸만큼 넓힌 뒤 채운다 —
    // 예전엔 엔트리 채우기로 넘겨 아무것도 칠해지지 않았다(재현 2026-10-16: 1920×1080 칸, 그림 왼쪽 빈 곳).
    if (!raster.bounds.contains(event.point)) {
      // 픽셀 아트 모양은 넓히지 않는다(스프라이트 밖을 잘못 눌러 그림이 칸 전체가 되고 저장 때 k배로 아주 커짐 — 검토로 찾음). 칸 밖도.
      // 이때는 엔트리 채우기로도 넘기지 않는다(엔트리는 그림 밖 점을 범위 검사 없이 써서 엉뚱한 곳을 칠함 — 재현 2026-10-16).
      if (pixelOf(window.Entry?.playground?.object?.selectedPicture) || !parts.stage?.contains(event.point) || !plainRaster(raster)) return FILL_SKIP;
      raster = fillRasterToStage({ layer: parts.layer, stage: parts.stage, ep }) || raster;
      delete raster.__evrSigBefore; // 넓히기 전 요약은 뼈대 열기용 — 곧 화소를 칠하므로 버린다(남으면 다음 자세 그리기가 칠한 것을 버림)
    }
    const w = raster.width, h = raster.height;
    const local = raster.globalToLocal(event.point).add(new ep.paper.Point(w / 2, h / 2));
    const sx = Math.floor(local.x), sy = Math.floor(local.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
    const perUnit = w / raster.bounds.width; // 그림 좌표 1당 화소
    const image = raster.getImageData(new ep.paper.Rectangle(0, 0, w, h)), d = image.data;
    // 선 밑으로 1.5 넓히기는 투명 잠금이면 하지 않는다: 잠금은 칠해진 화소 색만 바꾸므로 넓힌 띠에 든 선 안쪽 가장자리까지 색이
    // 바뀌었다(검토로 찾음 2026-10-16 — 잠금 없을 때는 불투명한 선 화소를 건너뛰어 괜찮음)
    // 경계(선)는 보이는 레이어를 모두 겹친 그림에서 찾는다(사용자 결정 10-18 — 레이어가 여럿이면 지금 레이어만 보고 찾아 선이 다른 레이어에
    // 있으면 바깥까지 칠해졌음, 포토샵·이비스페인트의 '모든 레이어 참조'와 같은 방식). 칠은 지금 레이어에.
    const bounds = visibleLayersPixels(ep, raster, w, h) || d;
    const region = fillRegion(bounds, w, h, sx, sy, regionFill.gap * perUnit, pixelPen.alphaLock ? 0 : FILL_EXPAND * perUnit);
    if (!region) return null;
    const [R, G, B, A] = fillColorOf(ep.paper, tool.fillColor), fa0 = A / 255;
    for (let i = 0, p = 0; i < region.length; i++, p += 4) {
      if (!region[i]) continue;
      const da = d[p + 3] / 255;
      // 투명 잠금: 칠해진 화소만 색을 바꾸고(불투명도는 그대로) 투명한 곳은 건너뛴다
      if (pixelPen.alphaLock) {
        if (da > 0) { d[p] = R; d[p + 1] = G; d[p + 2] = B; }
        continue;
      }
      if (da >= 1) continue;
      const fa = fa0 * (1 - da), oa = da + fa;
      if (oa <= 0) continue;
      d[p] = (d[p] * da + R * fa) / oa; d[p + 1] = (d[p + 1] * da + G * fa) / oa;
      d[p + 2] = (d[p + 2] * da + B * fa) / oa; d[p + 3] = oa * 255;
    }
    raster.setImageData(image, new ep.paper.Point(0, 0));
    const q = (sy * w + sx) * 4;
    return `rgba(${d[q]},${d[q + 1]},${d[q + 2]},${d[q + 3] / 255})`;
  }
  // 누른 곳에 보이는 맨 위 도형. 칠해진 곳·선 위, 그리고 선만 있는 닫힌 도형의 안쪽(사용자 결정 10-19 — 엔트리 채우기와 같음).
  // 보이지 않는 곳은 대상이 아니다(검토 L: 확장 클리핑의 기준 밖·엔트리 클립 묶음의 틀 밖·작업 영역 밖에서 숨은 도형이 칠해졌음):
  // 숨김·불투명도 0·잠금·확장 도우미도 뺀다. 엔트리 그림판 안내선(선택 윤곽선 등)은 그림 층 밖이라 여기 없다.
  function gradientTargetAt(ep, layer, stage, point) {
    if (stage && !stage.contains(point)) return null;
    const P = ep.paper;
    const unitOf = item => { let unit = item; while (unit.parent && unit.parent !== layer) unit = unit.parent; return unit.parent === layer ? unit : null; };
    const alphaAt = raster => {
      if (!raster.width || !raster.height) return 0;
      const at = raster.globalToLocal(point).add(new P.Point(raster.width / 2, raster.height / 2));
      if (at.x < 0 || at.y < 0 || at.x >= raster.width || at.y >= raster.height) return 0;
      return raster.getImageData(new P.Rectangle(Math.floor(at.x), Math.floor(at.y), 1, 1)).data[3];
    };
    // 이 항목이 누른 곳에 그려지는가(Item#contains는 부모 좌표 점을 받는다)
    const paints = node => {
      if (!node.visible) return false;
      if (node.className === 'Raster') return alphaAt(node) > 0;
      if (node.children && node.className !== 'CompoundPath') return node.children.some(child => !child.clipMask && paints(child));
      if (node.contains(node.parent ? node.parent.globalToLocal(point) : point)) return true;
      if (node.className === 'Path' && !node.closed && !node.hasFill()) return false; // 칠 없는 열린 선은 칠할 대상이 아니다
      if (!node.hasStroke?.() || typeof node.getNearestPoint !== 'function') return false;
      const local = node.globalToLocal(point), near = node.getNearestPoint(local);
      return !!near && near.getDistance(local) <= (Number(node.strokeWidth) || 0) / 2;
    };
    const shownHere = node => {
      for (let n = node; n && n !== layer; n = n.parent) {
        if (!n.visible || n.opacity === 0 || n.locked) return false;
        const mask = n.parent?.clipped && n.parent.children.find(child => child.clipMask);
        if (mask && mask !== n && !mask.contains(n.parent.globalToLocal(point))) return false;
      }
      const unit = unitOf(node);
      if (!unit || isLayerHelper(unit)) return false;
      // 확장 클리핑 레이어: 기준이 숨었으면 안 보이고, 기준이 그려지는 곳에서만 보인다(hookClipDraw와 같은 규칙)
      const base = unit.data?.evrClip ? clipBaseOf(unit) : null;
      if (base && (!base.visible || !base.opacity || !paints(base))) return false;
      return true;
    };
    const leaves = layer.getItems({ match: node => !node.clipMask && (node.className === 'Raster' || node.className === 'CompoundPath' ||
      node.className === 'Shape' || node.className === 'PointText' || (node.className === 'Path' && node.parent?.className !== 'CompoundPath')) });
    for (let i = leaves.length - 1; i >= 0; i--) if (shownHere(leaves[i]) && paints(leaves[i])) return leaves[i];
    return null;
  }
  // 그라데이션 칠하기(포토샵·일러스트레이터 방식 — 위 그라데이션 설명). grad = { start, end }(그림 좌표). 바꿨으면 true.
  function vectorGradientFill(ep, tool, point, grad) {
    const parts = paintLayer(ep), P = ep.paper;
    if (!parts) return false;
    const target = gradientTargetAt(ep, parts.layer, parts.stage, point);
    // 빈 곳은 칠하지 않는다(사용자 결정 10-19 — 예전엔 작업 영역 크기 배경 사각형을 깔아 저장 모양이 무대만 해졌음: 캐릭터 크기·충돌이 바뀜)
    if (!target) { toast('도형 위에서 끄세요 — 빈 곳에서는 칠하지 않습니다.', 2500); return false; }
    if (target.className === 'Raster') { toast('그림(이미지)에는 그라데이션을 칠할 수 없습니다 — 도형 위에서 끄세요.', 3000); return false; }
    // paper는 그라데이션 점을 그 항목의 부모 좌표로 읽는다(Color#toCanvasStyle이 항목 행렬을 거꾸로 건다 — 검토 L, 엔트리 번들 paper 확인).
    // 자기 변환을 가진 경로(엔트리 선 도구로 닫은 경로 = applyMatrix false, 옮기면 행렬에 남음)는 저장 SVG가 그 변환을 따로 적어 다시 열면 점이
    // 어긋나므로 먼저 변환을 점에 반영한다(다시 연 뒤와 같은 상태).
    // 돌리거나 늘린 글상자·SVG 도형(자기 변환이 남는 항목)도 칠한다 — 저장 SVG에서는 그 요소의 좌표로 읽히므로 저장 때 바꿔 쓴다
    // (hookGradientSvgSpace — 10-19, 예전엔 안내만 띄움)
    if ((target.className === 'Path' || target.className === 'CompoundPath') && !target.applyMatrix && !target.matrix.isIdentity()) target.applyMatrix = true;
    const into = at => target.parent ? target.parent.globalToLocal(at) : at;
    target.fillColor = gradientPaperColor(P, tool.fillColor, into(grad.start), into(grad.end));
    return true;
  }
  function bitmapGradientFill(ep, tool, grad) {
    const parts = paintLayer(ep), P = ep.paper;
    let raster = parts?.layer.children[0];
    if (!(raster instanceof P.Raster) || !raster.width || !raster.height) return null;
    // 작업 영역 전체를 칠한다 — 그림이 작으면 넓힌다(픽셀 모양은 넓히지 않음 — 영역 채우기와 같은 까닭)
    if (!pixelOf(window.Entry?.playground?.object?.selectedPicture) && plainRaster(raster)) {
      raster = fillRasterToStage({ layer: parts.layer, stage: parts.stage, ep }) || raster;
      delete raster.__evrSigBefore; // 영역 채우기와 같은 까닭(넓히기 전 요약은 뼈대 열기용 — 곧 칠하므로 버림, 검토 L)
    }
    const w = raster.width, h = raster.height;
    const toPixel = at => raster.globalToLocal(at).add(new P.Point(w / 2, h / 2));
    const image = raster.getImageData(new P.Rectangle(0, 0, w, h)), d = image.data;
    const gd = gradientPixels(P, tool.fillColor, w, h, toPixel(grad.start), toPixel(grad.end));
    // 픽셀 아트 모양(원래 해상도로 못 연 k배 그림)은 칸마다 한 색 — 칸 가운데 색으로(필터·사각 펜과 같은 칸, 검토 L)
    const c = context(), grid = c && pixelOf(c.picture) ? editorScale(c) : 1;
    if (grid > 1) {
      for (let cy = 0; cy < h; cy += grid) for (let cx = 0; cx < w; cx += grid) {
        const sx = Math.min(w - 1, cx + (grid >> 1)), sy = Math.min(h - 1, cy + (grid >> 1)), src = (sy * w + sx) * 4;
        const r = gd[src], g = gd[src + 1], b = gd[src + 2], a = gd[src + 3];
        for (let y = cy; y < Math.min(h, cy + grid); y++) for (let x = cx; x < Math.min(w, cx + grid); x++) {
          const q = (y * w + x) * 4; gd[q] = r; gd[q + 1] = g; gd[q + 2] = b; gd[q + 3] = a;
        }
      }
    }
    for (let p = 0; p < d.length; p += 4) {
      const da = d[p + 3] / 255, fa = gd[p + 3] / 255;
      // 투명 잠금: 칠해진 화소의 불투명도는 그대로 두고 그라데이션 투명도만큼 색을 섞는다(source-atop — 검토 L: 예전엔 투명한 끝도 시작 색 100%)
      if (pixelPen.alphaLock) {
        if (da > 0) for (let k = 0; k < 3; k++) d[p + k] = gd[p + k] * fa + d[p + k] * (1 - fa);
        continue;
      }
      // 보통 혼합(포토샵 그라데이션 기본): 그라데이션을 기존 화소 위에
      const oa = fa + da * (1 - fa);
      if (oa <= 0) continue;
      for (let k = 0; k < 3; k++) d[p + k] = (gd[p + k] * fa + d[p + k] * da * (1 - fa)) / oa;
      d[p + 3] = oa * 255;
    }
    raster.setImageData(image, new P.Point(0, 0));
    return raster;
  }
  // 비트맵 레이어가 둘 이상이면 보이는 레이어를 화면처럼 겹친 그림(클리핑·불투명도 그대로 — composeLayers)을 지금 레이어 그림의 화소 자리에
  // 맞춘 RGBA. 한 장이면 null(지금 레이어 화소를 그대로 씀).
  function visibleLayersPixels(ep, raster, w, h) {
    const meta = layerMeta(ep);
    if (!meta || meta.layers.length < 2) return null;
    // 지금 레이어는 지금 그림(방금 넓힌 그림 포함)의 사본으로 — 레이어 목록·그림 보관은 건드리지 않는다(검토 지적: 예전엔 채울 때마다
    // 큰 사본을 보관에 쌓고 표시·레이어 창을 통째로 다시 그렸음)
    const now = paintSnapshot(ep);
    const all = flattenParts(clipGroups(meta.layers).map(group => groupComposite(group, layer => layer.id === meta.active ? now : layerContent(ep, meta, layer))).filter(Boolean));
    if (!all) return null;
    const k = w / raster.bounds.width, canvas = canvasOfSize(w, h), g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(all.canvas, Math.round((all.x - raster.bounds.x) * k), Math.round((all.y - raster.bounds.y) * k), all.canvas.width * k, all.canvas.height * k);
    return g.getImageData(0, 0, w, h).data;
  }
  function ensureRegionFill(painter) {
    const ep = painter?.entryPaint;
    for (const graphics of ['VECTOR', 'BITMAP']) {
      const tool = ep?.paper?.tools?.find(item => item.MY_MODE?.toolMode === 'FILL' && item.MY_MODE?.graphicsMode === graphics);
      if (!tool || tool.__evrRegionFill || typeof tool.onMouseDown !== 'function') continue;
      tool.__evrRegionFill = true;
      const down = tool.onMouseDown;
      tool.__evrOriginalDown = down; // 투명도 등에서 되돌리기 기록만 남길 때 쓴다
      if (graphics === 'VECTOR') {
        // 영역 채우기일 때는 엔트리의 "마우스를 올린 도형 색 미리 바꾸기"를 하지 않는다(누르면 그 도형을 칠해 버림)
        const move = tool.onMouseMove;
        if (typeof move === 'function') tool.onMouseMove = function (event) { if (!regionFill.on && !gradientFill.on) return move.call(this, event); };
        tool.__evrClearHover = () => { try { move?.call(tool, { point: new ep.paper.Point(-1e7, -1e7), item: null }); } catch {} };
        const fillAt = (self, event, grad) => {
          if (grad) {
            // 엔트리 채우기의 마우스 올림 상태(그 도형에 채우기 색을 미리 칠하고 표시를 닮)를 먼저 지운다 — 남아 있으면 그 도형을 못 고르고 색도 남음(검토 L)
            tool.__evrClearHover?.();
            let changed = false;
            try { changed = vectorGradientFill(ep, tool, event.point, grad); } catch (error) { console.warn('[entry-vector-rig] 그라데이션', error); }
            if (!changed) return undefined; // 바뀐 것이 없으면 되돌리기 기록을 남기지 않는다(검토 L: 빈 기록 칸이 생기고 '수정됨'이 됐음)
          } else if (regionFill.on) {
            try { vectorRegionFill(ep, tool, event); } catch (error) { console.warn('[entry-vector-rig] 영역 채우기', error); }
          }
          // 영역 채우기·그라데이션일 때 엔트리 쪽은 고를 도형이 없어 되돌리기 기록만 남긴다
          return down.call(self, event);
        };
        tool.onMouseDown = function (event) {
          const raw = event?.point;
          event = wrapToolEvent(ep, event);
          if (gradientFill.on && event?.point) return startGradientDrag(ep, tool, event, raw);
          // 놓기를 못 받아 남은 끌기는 버린다(남으면 다음 놓기가 옛 자리로 칠함 — 검토 지적)
          if (gradientDrag) cancelGradientDrag();
          return fillAt(this, event, null);
        };
        hookGradientDrag(ep, tool, fillAt);
      } else {
        const fillAt = (self, event, grad) => {
          if (!grad && !regionFill.on) return down.call(self, event);
          let seedColor = null;
          if (grad) {
            let painted = false;
            try {
              const raster = bitmapGradientFill(ep, tool, grad);
              painted = !!raster;
              const at = raster && raster.globalToLocal(event.point).add(new ep.paper.Point(raster.width / 2, raster.height / 2));
              if (at && at.x >= 0 && at.y >= 0 && at.x < raster.width && at.y < raster.height) {
                const q = raster.getImageData(new ep.paper.Rectangle(Math.floor(at.x), Math.floor(at.y), 1, 1)).data;
                seedColor = `rgba(${q[0]},${q[1]},${q[2]},${q[3] / 255})`;
              } else if (raster) seedColor = FILL_SKIP; // 누른 곳이 그림 밖 — 엔트리 채우기로 넘기지 않음(되돌리기 기록은 아래)
            } catch (error) { console.warn('[entry-vector-rig] 그라데이션', error); }
            if (!painted) return undefined; // 못 칠했으면 엔트리 단색 채우기로 넘기지 않는다(검토 L)
            if (seedColor === FILL_SKIP) { saveEntryHistory(ep); return undefined; }
          } else {
            try { seedColor = bitmapRegionFill(ep, tool, event); } catch (error) { console.warn('[entry-vector-rig] 영역 채우기', error); }
          }
          if (seedColor === FILL_SKIP) return undefined;
          if (!seedColor) return down.call(self, event);
          // 엔트리 비트맵 채우기는 누른 곳이 이미 그 색이면 아무것도 안 하고 되돌리기 기록만 남긴다 — 그 길로 기록만 남긴다
          const color = tool.fillColor;
          tool.fillColor = seedColor;
          try { return down.call(self, event); } finally { tool.fillColor = color; }
        };
        tool.onMouseDown = function (event) {
          const raw = event?.point;
          event = wrapToolEvent(ep, event);
          if (gradientFill.on && event?.point) return startGradientDrag(ep, tool, event, raw);
          if (gradientDrag) cancelGradientDrag();
          return fillAt(this, event, null);
        };
        hookGradientDrag(ep, tool, fillAt);
      }
    }
  }
  // 그라데이션 끌기: 누를 때 칠할 곳(영역은 누른 곳 기준)을 기억하고, 끄는 동안 방향선만 보이고, 놓을 때 칠한다(엔트리 쪽 누르기
  // 처리 — 되돌리기 기록 — 도 그때 부른다). 무한 배경에서 누른 곳이 칸 안으로 접혔으면 끝점도 같은 만큼 옮긴다.
  // paper 도구 이벤트의 point는 읽을 때마다 지금 마우스 자리를 준다(ToolEvent#getPoint → tool._point 복사) — 누른 순간 자리를 복사해
  // 고정한 사본을 남긴다(그대로 두면 놓을 때 읽혀 시작점 = 끝점이 됨, 시험으로 잡음).
  function startGradientDrag(ep, tool, event, raw) {
    const point = event.point.clone();
    gradientDrag = { tool, event: Object.create(event, { point: { value: point } }), raw: (raw || point).clone() };
    showGradientGuide(ep, gradientDrag.raw, gradientDrag.raw);
    return undefined;
  }
  function hookGradientDrag(ep, tool, fillAt) {
    const drag = tool.onMouseDrag, up = tool.onMouseUp;
    // Shift는 마우스 이벤트에서 읽는다(paper Key.modifiers는 키보드 이벤트로만 바뀜)
    const shiftOf = event => !!(event.event?.shiftKey || event.modifiers?.shift);
    tool.onMouseDrag = function (event) {
      if (gradientDrag?.tool !== tool) return drag?.call(this, event);
      showGradientGuide(ep, gradientDrag.raw, gradientEnd(gradientDrag.raw, event.point, shiftOf(event)));
      return undefined;
    };
    tool.onMouseUp = function (event) {
      if (gradientDrag?.tool !== tool) return up?.call(this, event);
      const job = gradientDrag;
      cancelGradientDrag();
      const rawEnd = gradientEnd(job.raw, event.point, shiftOf(event));
      const view = ep.project.view;
      const moved = view.projectToView(job.raw).getDistance(view.projectToView(rawEnd)) >= GRADIENT_DRAG_MIN;
      const end = rawEnd.add(job.event.point.subtract(job.raw));
      // 끌지 않고 누르면 칠하지 않는다(포토샵 그라데이션 도구처럼 끌어야 칠함)
      const result = moved ? fillAt(this, job.event, { start: job.event.point, end }) : undefined;
      // 엔트리 쪽 누르기(fillAt 안)에 맞춰 놓기 처리도 부른다(다른 도구 훅과 같이 — 검토 지적)
      up?.call(this, event);
      return result;
    };
  }
  // 채우기 옵션 줄 끝에 영역 채우기·틈 막기
  function ensureFillOptions(painter) {
    const ep = painter?.entryPaint, active = ep?.paper?.tool;
    const isFill = active?.MY_MODE?.toolMode === 'FILL';
    // 끄는 도중 도구가 바뀌었으면 그라데이션 끌기를 버린다(방향선이 남지 않게)
    if (gradientDrag && gradientDrag.tool !== active) cancelGradientDrag();
    const bar = document.querySelector('#entryPainter .bottom_area > div');
    let box = document.querySelector('#entryPainter .evr-fill-opts');
    if (!isFill && gradientFill.on) { gradientFill.on = false; cancelGradientDrag(); }
    if (!isFill || !bar) { box?.remove(); ensureGradientWindow(false); return; }
    if (!box) box = buildFillOptions(ep);
    box.dataset.graphics = active.MY_MODE.graphicsMode;
    placeOptionBox(bar, box);
    syncFillOptions(box);
  }
  function buildFillOptions(ep) {
    const box = document.createElement('div');
    box.className = 'evr-brush-opts evr-fill-opts';
    const title = document.createElement('span');
    title.className = 'evr-brush-title';
    title.textContent = '영역 채우기';
    const toggle = button('영역 채우기', () => {
      regionFill.on = !regionFill.on;
      cancelGradientDrag();
      // 켜는 순간 엔트리가 미리 바꿔 둔 도형 색을 되돌린다
      if (regionFill.on) ep.paper.tools.forEach(tool => tool.__evrClearHover?.());
      syncFillOptions(box);
    }, { class: 'evr-brush-toggle evr-fill-toggle',
      title: '확장: 선으로 둘러싼 곳을 눌러 채움(보이는 그림 전체 기준, 선 아래로 1.5px 넓혀 채움). 끄면 엔트리 원래 채우기' });
    const level = document.createElement('label');
    level.className = 'evr-brush-level';
    level.title = '틈 막기: 이 값의 두 배보다 좁은 선 사이 틈은 막힌 것으로 보고 채움(그림 px). 끔이면 틈으로 새어 나감';
    const text = document.createElement('span');
    text.textContent = '틈 막기';
    const range = document.createElement('input');
    Object.assign(range, { type: 'range', min: '0', max: String(FILL_GAP_MAX), step: '1' });
    range.addEventListener('input', () => { regionFill.gap = Number(range.value); syncFillOptions(box); });
    range.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        event.stopPropagation();
    });
    const value = document.createElement('b');
    level.append(text, range, value);
    // 비트맵: 투명 잠금(붓·선과 같은 값 — 켜면 칠해진 화소의 색만 바꿈)
    const lock = button('투명 잠금', () => { toggleAlphaLock(); syncFillOptions(box); },
      { class: 'evr-brush-toggle evr-pen-lock', title: '확장: 칠해진 곳의 색만 바꿈(투명한 곳은 채우지 않음). 붓·선과 함께 적용' });
    const row = document.createElement('div');
    row.className = 'evr-brush-row';
    row.append(toggle, level, lock);
    box.append(title, row);
    return box;
  }
  function syncFillOptions(box) {
    const toggle = box.querySelector('.evr-fill-toggle');
    if (toggle.getAttribute('aria-pressed') !== String(regionFill.on)) toggle.setAttribute('aria-pressed', String(regionFill.on));
    const lock = box.querySelector('.evr-pen-lock');
    if (lock.getAttribute('aria-pressed') !== String(pixelPen.alphaLock)) lock.setAttribute('aria-pressed', String(pixelPen.alphaLock));
    lock.hidden = box.dataset.graphics !== 'BITMAP';
    const range = box.querySelector('input');
    if (Number(range.value) !== regionFill.gap) range.value = String(regionFill.gap);
    const label = regionFill.gap ? `${regionFill.gap}px` : '끔';
    const value = box.querySelector('.evr-brush-level b');
    if (value.textContent !== label) value.textContent = label;
    // 그라데이션 도구: 영역 채우기 켜기 단추·틈 막기는 숨김(칠하는 범위는 레이어 전체·도형 — 위 그라데이션 설명)
    const off = !regionFill.on && !gradientFill.on;
    if (box.dataset.off !== String(off)) box.dataset.off = String(off);
    if (toggle.hidden !== gradientFill.on) toggle.hidden = gradientFill.on;
    const gapLevel = box.querySelector('.evr-brush-level'); // 틈 막기 — 그라데이션은 선으로 둘러싼 곳을 찾지 않으므로 숨김
    if (gapLevel.hidden !== gradientFill.on) gapLevel.hidden = gradientFill.on;
    const title = box.querySelector('.evr-brush-title'), titleText = gradientFill.on ? '그라데이션' : '영역 채우기';
    if (title.textContent !== titleText) title.textContent = titleText;
    ensureGradientWindow(gradientFill.on);
  }
  // ---- 고른 도형 투명도(벡터) ----
  // 엔트리 그림판에는 투명도 조절이 없다. 선택 도구로 고른 도형·이미지(레이어)의 불투명도(paper opacity, 저장 SVG의
  // opacity)를 0~100%로 바꾼다. 막대를 놓을 때 되돌리기 기록을 하나 남긴다: 엔트리 벡터 채우기의 원래 누르기 처리는 고른
  // 도형이 없으면 기록(It.saveSnapshot)만 남기므로 그 길을 쓴다(마우스를 올린 도형 미리보기는 먼저 지운다).
  function saveEntryHistory(ep) {
    const fill = ep?.paper?.tools?.find(tool => tool.MY_MODE?.toolMode === 'FILL' && tool.MY_MODE?.graphicsMode === 'VECTOR');
    if (typeof fill?.__evrOriginalDown !== 'function') return false;
    fill.__evrClearHover?.();
    fill.__evrOriginalDown.call(fill, { point: new ep.paper.Point(-1e7, -1e7) });
    return true;
  }
  function selectedPaintItems(ep) {
    const layer = paintLayer(ep)?.layer;
    if (!layer) return [];
    // 고른 묶음 안의 도형까지 겹쳐 세지 않게, 위쪽이 이미 고른 것은 뺀다. data.guideItem은 엔트리가 고른(또는 마우스를 올린)
    // 원래 도형에 붙이는 윤곽선 복제본 참조라 빼면 안 된다(복제본 자체는 안내 층에 있어 여기 안 나옴). 예전에 이걸로 빼서
    // 경로 하나(사각·원·선·붓 획)를 고르면 막대가 안 떴다 — 묶음(엔트리봇 조각)은 참조가 없어 떴음(entry-paint 260921, 실제 엔트리에서
    // 엔트리 선택 상태 paint.selectedItems와 14가지 선택 경로 대조).
    return layer.getItems({ match: item => item.data?.selected })
      .filter(item => { for (let p = item.parent; p && p !== layer; p = p.parent) if (p.data?.selected) return false; return true; });
  }
  // 선택 도구 옵션 줄은 엔트리 칸만으로 거의 차서(폭 1600에서 넘침 109px) 끝에 붙이면 보이지 않는다. 엔트리 칸을 밀어내지
  // 않게, 고른 것이 있을 때만 그림 칸 왼쪽 위에 작은 상자로 띄운다.
  // 막대가 고칠 항목: 벡터는 고른 도형, 비트맵은 떠 있는 선택 조각. 엔트리 비트맵 선택은 고른 부분을 그림 조각(Raster)으로
  // 떼어 두고 선택을 풀 때 굽어 합친다(Lr → jr — paper rasterize는 항목 불투명도를 넣어 굽는다) — 그래서 조각 불투명도가 그림에 들어간다.
  function opacityTargets(ep) {
    const active = ep?.paper?.tool;
    if (active?.MY_MODE?.toolMode !== 'SELECT') return [];
    if (active.MY_MODE.graphicsMode === 'VECTOR') return selectedPaintItems(ep);
    const layer = paintLayer(ep)?.layer;
    return (paintStore()?.getState().paint.selectedItems || []).filter(item => isRasterLayer(item) && item.parent === layer);
  }
  function ensureOpacityOptions(painter) {
    const ep = painter?.entryPaint, items = opacityTargets(ep), vector = ep?.mode === 'VECTOR';
    const area = document.querySelector('#entryPainter .canvas_area');
    let box = document.querySelector('#entryPainter .evr-opacity-opts');
    if (!items.length || !area || session) { box?.remove(); return; }
    if (!box) box = buildOpacityOptions(ep);
    if (box.parentElement !== area) area.append(box);
    // 끄는 중이 아니면 고른 도형의 지금 불투명도를 보여 준다(여럿이면 첫 도형)
    if (!box.dataset.dragging) syncOpacityOptions(box, Math.round((items[0].opacity ?? 1) * 100));
    const make = box.querySelector('.evr-clip-make'), release = box.querySelector('.evr-clip-release');
    const canMake = vector && items.length > 1 && items.every(item => item.parent === items[0].parent);
    if (make.hidden !== !canMake) make.hidden = !canMake;
    const canRelease = vector && items.length === 1 && !!clipGroupOf(items[0]);
    if (release.hidden !== !canRelease) release.hidden = !canRelease;
  }
  function buildOpacityOptions(ep) {
    const box = document.createElement('div');
    box.className = 'evr-opacity-opts';
    const title = document.createElement('span');
    title.className = 'evr-opacity-title';
    title.textContent = '투명도';
    const level = document.createElement('label');
    level.className = 'evr-brush-level';
    level.title = '고른 도형·이미지의 불투명도(100% = 원래대로, 0% = 안 보임). 저장한 모양에도 그대로 남음';
    const range = document.createElement('input');
    Object.assign(range, { type: 'range', min: '0', max: '100', step: '1' });
    range.style.width = '110px';
    const value = document.createElement('b');
    range.addEventListener('input', () => {
      box.dataset.dragging = 'true';
      const opacity = Number(range.value) / 100;
      opacityTargets(ep).forEach(item => { item.opacity = opacity; });
      syncOpacityOptions(box, Number(range.value));
    });
    range.addEventListener('change', () => {
      delete box.dataset.dragging;
      if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 투명도: 되돌리기 기록을 남기지 못함');
    });
    // 방향키로 막대를 움직일 때 엔트리가 고른 도형을 옮기지 않게
    range.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        event.stopPropagation();
    });
    // 상자 위 마우스 움직임이 엔트리 선택 도구의 "마우스 올린 도형" 표시로 가지 않게
    for (const type of ['mousemove', 'pointermove', 'mousedown', 'pointerdown']) box.addEventListener(type, event => event.stopPropagation());
    level.append(range, value);
    const make = button('클리핑 마스크', () => makeClipMask(ep), { class: 'evr-brush-toggle evr-clip-make',
      title: '고른 도형 중 맨 위 도형 모양 안에서만 나머지가 보이게(일러스트레이터 클리핑 마스크와 같음, 지워지지 않음)' });
    const release = button('마스크 풀기', () => releaseClipMask(ep), { class: 'evr-brush-toggle evr-clip-release',
      title: '클리핑 마스크를 풀어 틀 도형과 나머지를 원래대로' });
    make.hidden = release.hidden = true;
    box.append(title, level, make, release);
    return box;
  }
  // ---- 벡터 클리핑 마스크 ----
  // 일러스트레이터 "클리핑 마스크 만들기"와 같은 규칙: 고른 것 중 맨 위 도형이 틀(clipMask)이 되고, 나머지는 그 모양 안에서만
  // 보인다(paper 잘라 보이는 묶음 — 묶음의 첫 항목이 틀). 저장 SVG에는 clipPath로, 실행 화면 PNG에는 잘린 그대로 들어간다.
  // 엔트리는 SVG를 열 때 항목이 하나뿐인 묶음을 계속 풀어 잘라 보이는 묶음이 사라지지만(실험), 확장 저장에는 기준점 상자가 함께
  // 들어가 그대로 남는다(실험: 묶음 + 다른 도형 하나 → 다시 열어도 잘려 보임).
  const isClipGroup = item => item?.className === 'Group' && !!item.clipped && !!item.firstChild?.clipMask;
  // 저장했다 다시 열면(엔트리 SVG 열기) 잘라 보이는 묶음이 바깥 묶음 하나에 싸여 들어온다(실험) — 항목 하나뿐인 묶음은 안으로 따라간다
  function clipGroupOf(item) {
    for (let node = item; node?.className === 'Group'; node = node.children.length === 1 ? node.firstChild : null)
      if (isClipGroup(node)) return node;
    return null;
  }
  // 틀의 칠·선: paper는 clipMask를 켜면 틀과 그 안 모든 도형의 칠·선을 지운다(Item#setClipMask → setFillColor(null), 묶음이면 자식까지).
  // SVG clipPath에도 칠이 안 남는다. 예전엔 틀 자신 것만 적어 둬, 묶음(엔트리봇 조각 등)을 틀로 했다 풀면 안 도형 색이 모두 사라졌다
  // (사용자 제보 "클리핑을 풀면 그림이 사라짐" — 실제 엔트리 재현). 틀과 그 안 항목마다 적어 두고 되살린다(위 항목부터 — 묶음 색을 먼저 칠한 뒤
  // 자식 색으로 덮음).
  // 색은 글(CSS)로, 그라데이션은 정지점·점 자리로 적는다(저장 SVG의 data에도 남음). 예전엔 그라데이션을 빼고 적어, 그라데이션 칠한 도형을
  // 틀로 했다 풀면 칠이 사라졌다(10-19 찾음). 색 글은 rgba로 적는다 — 16진 글(toCSS(true))은 투명도를 버려, 끝이 투명한 그라데이션·반투명
  // 틀이 풀면 불투명해졌다(검토 M, 시험 재현). 예전에 적은 16진 글도 그대로 읽힌다.
  const maskCss = color => {
    if (!color) return null;
    if (color.type !== 'gradient') return color.toCSS(false);
    const at = point => point ? [point.x, point.y] : null;
    return { gradient: { stops: color.gradient.stops.map(stop => [stop.color.toCSS(false), stop.offset]), radial: !!color.gradient.radial },
      origin: at(color.origin), destination: at(color.destination), highlight: at(color.highlight) };
  };
  const maskColorOf = (P, value) => typeof value === 'string' ? new P.Color(value) : new P.Color({
    gradient: { stops: value.gradient.stops.map(([css, offset]) => new P.GradientStop(new P.Color(css), offset)), radial: value.gradient.radial },
    origin: value.origin, destination: value.destination, ...(value.highlight ? { highlight: value.highlight } : {}) });
  // 적어 둔 틀 색에 색 필터를 건다(벡터 필터 — 틀은 칠이 지워져 있어 적어 둔 색에 걸어야 [마스크 풀기] 뒤에도 필터 색, 10-19 고침)
  function filterMaskStyle(P, style, css) {
    const one = value => {
      if (!value) return value;
      if (typeof value === 'string') return filterColor(P, new P.Color(value), css).toCSS(false);
      return { ...value, gradient: { ...value.gradient, stops: value.gradient.stops.map(([c, offset]) => [filterColor(P, new P.Color(c), css).toCSS(false), offset]) } };
    };
    return { ...style, fill: one(style.fill), stroke: one(style.stroke) };
  }
  function saveMaskStyles(mask) {
    for (const item of [mask, ...mask.getItems({})]) {
      const fill = maskCss(item.fillColor), stroke = maskCss(item.strokeColor);
      if (fill || stroke) item.data.evrMaskStyle = { fill, stroke, width: Number(item.strokeWidth) || 0 };
    }
  }
  function restoreMaskStyle(P, item) {
    const style = item.data?.evrMaskStyle;
    if (!style) return;
    if (style.fill) item.fillColor = maskColorOf(P, style.fill);
    if (style.stroke) { item.strokeColor = maskColorOf(P, style.stroke); item.strokeWidth = style.width || 1; }
    delete item.data.evrMaskStyle;
  }
  function restoreMaskStyles(P, mask) {
    for (const item of [mask, ...(mask.getItems?.({}) || [])]) restoreMaskStyle(P, item);
  }
  // 틀이 될 수 있는 것: 경로(도형)뿐 — paper는 경로 모양으로만 자른다. 그림(Raster)·글자를 틀로 하면 아래가 안 잘리고 그림이 그대로
  // 보였다(실험).
  const maskable = item => !['Raster', 'PointText', 'SymbolItem'].includes(item.className) && pathItems(item).length > 0 &&
    !item.getItems?.({ match: inner => ['Raster', 'PointText', 'SymbolItem'].includes(inner.className) }).length;
  function makeClipMask(ep) {
    const items = selectedPaintItems(ep);
    if (items.length < 2) return;
    const parent = items[0].parent;
    if (!items.every(item => item.parent === parent)) { toast('같은 묶음 안의 도형끼리만 클리핑 마스크를 만들 수 있습니다.', 3000); return; }
    const sorted = items.slice().sort((a, b) => a.index - b.index), mask = sorted[sorted.length - 1];
    if (!maskable(mask)) {
      toast('맨 위가 그림(이미지)·글자라 틀로 쓸 수 없습니다. 틀은 도형이어야 합니다 — 위 레이어를 아래 레이어 모양 안에만 보이게 하려면 레이어 창 [클리핑]을 쓰세요.', 6000);
      return;
    }
    // 엔트리 선택(도형 복제 윤곽선)을 먼저 푼다 — 묶은 뒤에는 옛 자리 윤곽선이 남는다
    try { ep.getPaperJSON(); } catch (error) { console.warn('[entry-vector-rig] 엔트리 선택 풀기 실패', error); }
    saveMaskStyles(mask);
    mask.data.evrMask = true; // 확장이 만든 틀(엔트리 그룹 해제 가로채기 표시 — 묶음 틀은 자기 색 기록이 없음)
    const group = new ep.paper.Group({ insert: false });
    parent.insertChild(mask.index + 1, group);
    group.addChildren([mask, ...sorted.slice(0, -1)]);
    group.clipped = true;
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 클리핑 마스크: 되돌리기 기록을 남기지 못함');
  }
  function releaseClipMask(ep) {
    const [picked] = selectedPaintItems(ep), group = clipGroupOf(picked);
    if (!group) return;
    try { ep.getPaperJSON(); } catch (error) { console.warn('[entry-vector-rig] 엔트리 선택 풀기 실패', error); }
    // 마스크 묶음만 싸고 있던 바깥 묶음은 풀어 없앤다(풀고 나면 빈 껍데기라)
    const outer = picked !== group ? picked : null;
    const parent = outer ? outer.parent : group.parent, at = outer ? outer.index : group.index, mask = group.firstChild;
    mask.clipMask = false;
    restoreMaskStyles(ep.paper, mask);
    if (mask.data?.evrMask) delete mask.data.evrMask;
    const kids = group.removeChildren() || [];
    // 원래 순서: 나머지(아래) 위에 틀(맨 위)
    parent.insertChildren(at, [...kids.filter(item => item !== mask), mask]);
    group.remove();
    outer?.remove();
    if (!saveEntryHistory(ep)) console.warn('[entry-vector-rig] 마스크 풀기: 되돌리기 기록을 남기지 못함');
  }
  // 엔트리 "그룹 해제"(도구 막대 단추·Ctrl+G)는 잘라 보이는 묶음을 풀 때 틀을 버린다(entry-paint 260921 Un: clipMask 아닌 자식만 꺼내고
  // 묶음을 지움 — 외부 SVG의 잘라 보이기용). 확장이 만든 클리핑 마스크면 틀이 사용자 그림이라 통째로 사라졌다(사용자 제보 "클리핑을 풀면
  // 그림이 사라짐", 실제 엔트리 재현). 고른 것이 확장 마스크 묶음(틀에 색 기록)이면 엔트리 대신 [마스크 풀기]로 푼다. 다른 묶음은 엔트리 그대로.
  let ungroupHooked = false;
  // 엔트리 [그룹 해제](Un)는 자식 행렬에 묶음 행렬을 붙여 모양만 옮기고 칠은 옮기지 않는다(t.matrix.prepend(e.matrix) → transform(null) —
  // 번들 확인). paper는 그라데이션 점을 항목의 부모 좌표로 읽으므로, 옮겨 둔 엔트리 묶음 안 도형의 그라데이션이 풀고 나면 묶음을 옮긴 만큼
  // 어긋났다(검토 M, 시험 재현). 엔트리가 푼 뒤 묶음에서 나온 자식(도형·겹친 경로 — 안쪽 묶음은 paper가 손자 칠까지 옮기거나 자기 행렬로
  // 들고 감)의 그라데이션을 같은 묶음 행렬로 옮긴다. 엔트리는 풀 때 되돌리기 기록을 남기지 않아(번들 확인) 다음 기록에 고친 색이 들어간다.
  function keepGradientsOnUngroup(ep) {
    if (ep?.mode !== 'VECTOR') return;
    const picked = paintStore()?.getState().paint?.selectedItems || []; // 엔트리 onUnGroup이 보는 선택
    const group = picked.length === 1 && picked[0]?.className === 'Group' ? picked[0] : null;
    if (!group || !group.matrix || group.matrix.isIdentity()) return;
    const matrix = group.matrix.clone(), kids = group.children.slice();
    setTimeout(() => {
      try {
        for (const kid of kids) {
          if (kid.parent === group || !kid.isInserted() || (kid.children && kid.className !== 'CompoundPath')) continue;
          for (const key of ['fillColor', 'strokeColor']) {
            const color = kid[key];
            if (!color?.gradient) continue;
            const moved = new ep.paper.Color(color);
            moved.transform(matrix);
            kid[key] = moved;
          }
        }
      } catch (error) { console.warn('[entry-vector-rig] 그룹 해제 뒤 그라데이션 자리', error); }
    }, 0);
  }
  function ownMaskGroup(ep) {
    if (ep?.mode !== 'VECTOR') return null;
    const picked = selectedPaintItems(ep);
    if (picked.length !== 1) return null;
    const group = clipGroupOf(picked[0]);
    const mask = group?.firstChild;
    return mask && (mask.data?.evrMask || mask.data?.evrMaskStyle) ? group : null;
  }
  function hookUngroup() {
    if (ungroupHooked) return;
    ungroupHooked = true;
    const take = event => {
      const ep = window.Entry?.playground?.painter?.entryPaint;
      // 기준점 상자(확장 도우미 묶음)만 골려 있으면 풀지 않는다 — 풀면 상자가 1% 점 네 개의 보통 도형이 되어 그림·저장에 섞였다(10-19 시험 중 찾음)
      const picked = ep?.mode === 'VECTOR' ? selectedPaintItems(ep) : [];
      if (picked.length === 1 && isLayerHelper(picked[0])) {
        event.preventDefault(); event.stopImmediatePropagation();
        toast('기준점 상자는 그룹 해제하지 않습니다 — 그림 도형을 골라 주세요.', 2500); // 알림 없이 아무 일도 없으면 고장처럼 보임(검토 M)
        return true;
      }
      if (!ownMaskGroup(ep)) { keepGradientsOnUngroup(ep); return false; }
      event.preventDefault();
      event.stopImmediatePropagation();
      releaseClipMask(ep);
      return true;
    };
    document.addEventListener('click', event => {
      // 위쪽 도구 막대 단추(entry-paint 260921: button.withControlBtnWrapper, 글자 '그룹 해제' — '그룹화'와 같은 group 모양이라 글자로 가림)
      const button = event.target?.closest?.('#entryPainter button');
      if (button && button.innerText?.trim() === '그룹 해제') take(event);
    }, true);
    document.addEventListener('keydown', event => {
      // 엔트리와 같은 조건일 때만(entry-paint 260921 선택 도구 onKeyDown): 그림판 칸 포커스(paper View._focused) + 선택 도구 + Ctrl +
      // 'g'(paper가 소문자로 바꿔 Shift·Alt 상관없음), 입력 칸(INPUT)은 제외. Mac Cmd는 paper control이 아니라 엔트리도 풀지 않는다.
      if (!event.ctrlKey || event.key?.toLowerCase() !== 'g' || event.target?.tagName === 'INPUT') return;
      const ep = window.Entry?.playground?.painter?.entryPaint;
      if (paintStore()?.getState().tool?.toolMode !== 'SELECT' || !ep?.project?.view || ep.paper?.View?._focused !== ep.project.view) return;
      take(event);
    }, true);
  }
  // 잘라 보이는 묶음이 다른 길로 풀려(엔트리 "그룹 해제"는 틀을 버리므로 확장 마스크는 hookUngroup이 [마스크 풀기]로 바꿈) 틀 도형이
  // clipMask인 채 그림 층에 남으면, paper는 틀을 가진 묶음(층 포함)을 그 틀로 잘라 그림 층 전체가 잘려 보이므로 묶음 첫 항목이 아닌 틀은
  // 보통 도형으로 되돌린다.
  function fixStrayClipMasks(ep) {
    const layer = ep?.mode === 'VECTOR' && paintLayer(ep)?.layer;
    if (!layer) return;
    for (const item of layer.getItems({ match: it => it.clipMask })) {
      const parent = item.parent;
      if (parent && parent !== layer && parent.clipped && parent.firstChild === item) continue;
      // 그룹 해제로 풀린 틀: 틀 표시만 끄면 칠·선이 지워진 채 투명한 도형으로 남았다 — 적어 둔 색도 되살린다
      item.clipMask = false;
      restoreMaskStyles(ep.paper, item);
    }
    // 색 기록이 남았는데 지금 틀 안이 아닌 항목: 엔트리 "그룹 해제"는 틀 표시까지 꺼 위에서 못 찾는다(시험으로 찾음 — 묶음 틀 그림이 사라짐)
    const inMask = item => {
      for (let node = item; node && node !== layer; node = node.parent)
        if (node.clipMask && node.parent?.clipped && node.parent.firstChild === node) return true;
      return false;
    };
    for (const item of layer.getItems({ match: it => it.data?.evrMaskStyle })) if (!inMask(item)) restoreMaskStyle(ep.paper, item);
  }
  function syncOpacityOptions(box, percent) {
    const range = box.querySelector('input');
    if (Number(range.value) !== percent) range.value = String(percent);
    const value = box.querySelector('.evr-brush-level b'), label = `${percent}%`;
    if (value.textContent !== label) value.textContent = label;
  }
  function refresh() {
    inkGeneration++;
    const c = context();
    const painter = window.Entry?.playground?.painter;
    if (painter) {
      ensureSaveHook(painter);
      ensureLoadHook(painter);
      try { ensureSvgIdFix(painter); } catch (error) { console.warn('[entry-vector-rig] SVG 이름 겹침', error); }
      try { watchVectorPick(); } catch (error) { console.warn('[entry-vector-rig] 레이어 창 고른 줄', error); }
      try { ensurePainterNav(painter); } catch (error) { console.warn('[entry-vector-rig] 편집기 이동·확대', error); }
      try { ensureSmoothBrush(painter); ensureBrushOptions(painter); }
      catch (error) { console.warn('[entry-vector-rig] 부드러운 붓', error); }
      try { ensureSelectKeepsAlpha(painter); } catch (error) { console.warn('[entry-vector-rig] 선택 반투명 지키기', error); }
      try { ensureRegionFill(painter); ensureFillOptions(painter); ensureGradientTool(); }
      catch (error) { console.warn('[entry-vector-rig] 영역 채우기', error); }
      try { ensurePixelPen(painter); ensurePixelPenOptions(painter); }
      catch (error) { console.warn('[entry-vector-rig] 사각 펜·투명 잠금', error); }
      try { normalizeVectorLayers(painter.entryPaint); } catch (error) { console.warn('[entry-vector-rig] 벡터 레이어 정리', error); }
      try { checkFilterPanel(painter); } catch (error) { console.warn('[entry-vector-rig] 필터 창', error); }
      try { refreshLayers(painter.entryPaint); } catch (error) { console.warn('[entry-vector-rig] 레이어', error); }
      try { fixStrayClipMasks(painter.entryPaint); } catch (error) { console.warn('[entry-vector-rig] 클리핑 마스크 정리', error); }
      try { healEntryOutlines(painter.entryPaint); } catch (error) { console.warn('[entry-vector-rig] 선택 윤곽선 맞추기', error); }
      try { restoreEntLayers(); } catch (error) { console.warn('[entry-vector-rig] .ent 레이어 이어 주기', error); }
      try { ensureOpacityOptions(painter); } catch (error) { console.warn('[entry-vector-rig] 투명도', error); }
      try { ensureCanvasArea(painter); } catch (error) { console.warn('[entry-vector-rig] 캔버스 크기', error); }
    }
    // 그림판이 아직 없어도(모양 탭을 열기 전) 그림판 클래스를 미리 감싼다 — 첫 그림부터 SVG 이름 겹침을 고친다
    try { hookSvgIdProto(window.EntryPaint?.default?.prototype); } catch (error) { console.warn('[entry-vector-rig] SVG 이름 겹침', error); }
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
    restoreEntPictures();
    restorePixelFileurls();
    try { ownPixelPictures(); } catch (error) { console.warn('[entry-vector-rig] 모양 자기 파일', error); }
    try { hookLoadRepair(); } catch (error) { console.warn('[entry-vector-rig] 모양 주소 잇기', error); }
    try { hookDraftMenu(); } catch (error) { console.warn('[entry-vector-rig] 그림 임시저장 메뉴', error); }
    try { checkEntryPicker(); } catch (error) { console.warn('[entry-vector-rig] 엔트리 색 고르기 창', error); }
    // 모양을 바꾸는 틈(context()가 비어 있음)에는 십자·뼈대 버튼·도구 막대를 지우지 않고 그대로 둔다 — 지웠다 다시 만들면 켜 둔
    // "그림 전체 이동" 같은 모드가 풀렸다(검토로 찾음 2026-10-16)
    if (!pictureSwitching()) {
      if (c) tidyPixelPainter(c);
      refreshPivotUI(c);
      ensureRigModeButton(c);
      if (session) draw(session);
      const top = document.getElementById('entryPainter')?.querySelector('.top_area');
      ensureToolButtons(c, top);
    }
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
      const rename = button('이름 붙이기', () => {
        const selected = context();
        if (selected) openRenameDialog(selected);
      }, { class: 'evr-tool evr-rename-open',
        title: '이 오브젝트의 모양들을 골라 "이름_번호"로 한꺼번에 이름 바꾸기(되돌리기 가능)' });
      const canvasSize = button('캔버스', () => {
        const selected = context();
        if (selected) openCanvasDialog(selected);
      }, { class: 'evr-tool evr-canvas-open',
        title: '그림판 크기를 960×540보다 크게(최대 4096) · 무한 배경(가로·세로로 이어지는 그림) 그리기' });
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
      // 화면이 좁아 "비트맵 | 벡터" 옆 뼈대 버튼이 엔트리 오른쪽 버튼에 가려질 때(폭 약 1260px 미만, 1.0.0 제보) 이 목록에서도
      // 뼈대 모드를 켜고 끌 수 있게 한다. 위쪽 버튼은 그대로 둔다(자리를 옮겼다 되돌리며 깜빡이지 않게).
      const bone = button('뼈대', () => {
        const header = document.querySelector('.evr-mode-wrap[data-evr-mode="bone"] .evr-bone-mode');
        if (session) close();
        else { const c = context(); if (c) open(c, header); }
      }, { class: 'evr-tool evr-bone-menu', 'aria-pressed': 'false', title: '뼈대 모드(벡터 모양)' });
      list.append(bone, pixel, split, rename, canvasSize, arrange, align, center, onion, pin);
      // 접힌 목록에서 하나를 고르면 목록을 닫는다(버튼 동작이 먼저 실행된 뒤).
      list.addEventListener('click', () => { tools.dataset.open = 'false'; });
      tools.append(more, list);
    }
    const save = [...top.querySelectorAll('button')].find(b => b.textContent.trim() === '저장하기');
    const box = save?.parentElement?.parentElement || top;
    if (tools.parentElement !== box) box.prepend(tools);
    const pixel = tools.querySelector('.evr-pixel'), on = objectPixel(c.object) > 0;
    if (pixel.getAttribute('aria-pressed') !== String(on)) pixel.setAttribute('aria-pressed', String(on));
    const boneMenu = tools.querySelector('.evr-bone-menu'), boneHeader = document.querySelector('.evr-bone-mode');
    if (boneMenu) {
      const disabled = boneHeader ? boneHeader.disabled : true;
      if (boneMenu.disabled !== disabled) boneMenu.disabled = disabled;
      if (boneMenu.getAttribute('aria-pressed') !== String(!!session)) boneMenu.setAttribute('aria-pressed', String(!!session));
    }
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
    // 글자를 숨겨야 할 만큼 좁으면 위쪽 뼈대 버튼이 엔트리 버튼에 가려질 수 있어 도구 목록에도 뼈대를 둔다
    if (tools.dataset.boneInMenu !== String(narrow)) tools.dataset.boneInMenu = String(narrow);
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
  hookEntDownload();
  hookLoadRepair();
  hookUngroup();
  refresh();
})();
