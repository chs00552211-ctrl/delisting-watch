# 시총 미달 종목판

상장폐지 매출액 기준은 넘지만 시가총액 기준에 못 미치는 코스피·코스닥 종목을 섹터별로 보여주는 정적 사이트입니다.

- 데이터: 네이버 증권 공개 데이터
- 갱신: GitHub Actions가 평일 16:40(KST)에 `scripts/build.mjs`를 실행하고 GitHub Pages에 배포
- 수동 갱신: GitHub 저장소 → Actions → "데이터 갱신 및 배포" → Run workflow
- 로컬 실행: `node scripts/build.mjs` 후 `public/index.html` 열기

기준 금액은 `scripts/template.html`의 `STAGES`에서 바꿀 수 있습니다.

## 회복 사례 탭

`scripts/history.mjs`가 2024년 이후 시총 기준 아래로 떨어졌다가 상장폐지 없이 회복한 종목을 모읍니다.

- 공식 사례: KIND 공시(시총 미달 관리종목 해제, 지정우려 경고 후 미지정)
- 추정 사례: 코스피 등 경고 공시가 없는 구간은 수정주가 × 현재 주식수로 시총을 추정
- KIND는 요청이 많으면 IP를 막으므로 요청을 하나씩 보내고, 결과를 `data/kind-cache.json`에 쌓아 워크플로가 커밋합니다.
- KIND 조회가 실패하면 `data/history.json` 스냅샷을 그대로 씁니다.
