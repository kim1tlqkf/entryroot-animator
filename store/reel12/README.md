# 1.2 홍보 APNG 다시 만들기

결과: `../promo_reel12_apng.png` (640×360, 15초, 1초 12.5장, 96색, 1,037,799바이트 — 엔트리 노팁 그림 한도 1MB 안).

1. `python build.py` — `../promo_reel.svg`(1.0 영상)에서 엔트리봇 두 자세를 꺼내 옷/선·얼굴로 나누고 `reel12.html`을 만든다.
2. `node cdp_render.js reel12.html full 1280 720 "t => window.renderAt(t)" "0:14.92:0.08"` — 창 없는 크롬으로 187장 찍기.
3. `python assemble.py full ../promo_reel12_apng.png 80 96` — 640×360으로 줄이고 공통 색표(핵심 색 고정)로 APNG.

색을 늘리면(112) 1MB에 거의 닿는다(1,046,026). 장면을 바꿔 1MB를 넘으면 색 수부터 줄인다.
