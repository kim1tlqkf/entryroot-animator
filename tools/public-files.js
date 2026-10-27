// 공개 저장소(GitHub 사본)에 올려도 되는 파일 — 허용 목록. 여기 없는 것은 공개하지 않는다. 금지 낱말 목록으로 거르면 목록 밖을 놓쳐서(과적합 검토)
// 거꾸로 "올려도 되는 것"만 정한다. 출시 기록(release/*.json·검토 보고서)은 대화 원문을 그대로 옮긴 인용 전체와 실제 서버 확인 기록(작품 번호
// 등)이 들어 있어 관문 근거로만 쓰고 공개하지 않는다. 허용 목록 안 파일(코드 주석·설명 글)의 짧은 인용은 공개 전 검사(public-copy-check)로만 거른다.
const ALLOW = [
  /^(manifest\.json|rig\.js|rig\.css|LICENSE|README\.md|pack\.ps1|\.gitignore)$/,
  /^vendor\/[^/]+$/,
  /^icons\/[^/]+$/,
  /^tools\/[^/]+\.(js|ps1)$/,
  /^release\/(README\.md|overfit-review-prompt\.md)$/,
  /^store\/[^/]+\.(md|png|gif|html|js|svg)$/,
  /^store\/(reel12|reel13|banner)\/[^/]+$/,
];
const isPublic = rel => ALLOW.some(rule => rule.test(rel));
module.exports = { isPublic };
