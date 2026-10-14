# 1.0 홍보 SVG에서 엔트리봇 두 자세를 꺼내고, 클리핑 장면용 "옷(파란 칠)만" 가면 모양을 만든 뒤 reel12.template.html에 넣는다.
import re, pathlib
here = pathlib.Path(__file__).parent
s = open(here.parent / 'promo_reel.svg', encoding='utf-8').read()
BLUE = {'#009ff8', '#009ff9', '#0088c2', '#0088c5'}
out = []
for sid in ('bot1', 'bot2'):
    sym = re.search(r'<symbol id="%s".*?</symbol>' % sid, s, re.S).group(0)
    out.append(sym)
    def keep_blue(m):
        p = m.group(0)
        f = re.search(r'fill:\s*(#[0-9a-fA-F]+)', p) or re.search(r'fill="(#[0-9a-fA-F]+)"', p)
        if not f or f.group(1).lower() not in BLUE:
            return ''
        p = re.sub(r'style="[^"]*"', 'style="fill:#fff"', p)
        p = re.sub(r'fill="[^"]*"', '', p)
        return p
    suit = re.sub(r'<path\b[^>]*?/>', keep_blue, sym)
    suit = suit.replace('id="%s"' % sid, 'id="%sSuit"' % sid, 1)
    out.append(suit)
    # 실제 클리핑처럼 레이어를 나눔: 옷(파란 칠, 원래 색) / 나머지(선·얼굴)
    def fill_of(p):
        f = re.search(r'fill:\s*(#[0-9a-fA-F]+)', p) or re.search(r'fill="(#[0-9a-fA-F]+)"', p)
        return f.group(1).lower() if f else ''
    blue = re.sub(r'<path\b[^>]*?/>', lambda m: m.group(0) if fill_of(m.group(0)) in BLUE else '', sym).replace('id="%s"' % sid, 'id="%sBlue"' % sid, 1)
    rest = re.sub(r'<path\b[^>]*?/>', lambda m: '' if fill_of(m.group(0)) in BLUE else m.group(0), sym).replace('id="%s"' % sid, 'id="%sRest"' % sid, 1)
    out += [blue, rest]
    print(sid, 'paths', sym.count('<path'), '-> suit', suit.count('<path'), 'blue', blue.count('<path'), 'rest', rest.count('<path'))
tpl = (here / 'reel12.template.html').read_text(encoding='utf-8')
(here / 'reel12.html').write_text(tpl.replace('<!--DEFS-->', '\n'.join(out)), encoding='utf-8')
print('wrote reel12.html')
