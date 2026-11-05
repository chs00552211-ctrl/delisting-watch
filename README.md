# 시총 미달 종목판

상장폐지 매출액 기준은 넘지만 시가총액 기준에 못 미치는 코스피·코스닥 종목을 섹터별로 보여주는 정적 사이트입니다.

- 데이터: 네이버 증권 공개 데이터
- 갱신: GitHub Actions가 평일 16:40(KST)에 `scripts/build.mjs`를 실행하고 GitHub Pages에 배포
- 수동 갱신: GitHub 저장소 → Actions → "데이터 갱신 및 배포" → Run workflow
- 로컬 실행: `node scripts/build.mjs` 후 `public/index.html` 열기

기준 금액은 `scripts/template.html`의 `STAGES`에서 바꿀 수 있습니다.
