# 오프라인 공략 (namu.wiki → PWA)

나무위키의 게임 공략 문서 트리를 통째로 긁어서 **홈 화면에 설치 가능한 오프라인 PWA**로 만든다.
비행기 모드에서도 전체 문서·이미지·섹션 검색이 동작한다.

현재 책(book): `Vampire Survivors` (`scraper/sites/vampire-survivors.json`).
`pokemon-heartgold.json`은 틀만 잡아둔 상태(`enabled: false`).

## 1. 한 번 실행하면 끝

```bash
npm install                 # playwright 설치
npx playwright install chromium
npm run scrape -- --site vs # 나무위키 크롤 → data/raw/vs/
npm run build               # data/raw → docs/ (PWA)
npm run serve               # http://127.0.0.1:8090 로 확인
```

- 크롤은 진짜 Chromium으로 돌고, 문서당 1.5초 쉰다(200문서 ≈ 5분).
- Cloudflare 확인창이 뜨면 `npm run scrape -- --site vs --headed` 로 한 번만 수동 통과. 프로필(`.pw-profile/`)에 저장돼 다음부턴 안 뜬다.
- 이미 받은 문서는 재사용한다. 전부 새로 받으려면 `--fresh`.
- `docs/`만 커밋하면 된다(`data/`는 로컬 캐시).

## 2. 폰에 넣기 (GitHub Pages)

1. 레포 Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / **`/docs`** 저장.
2. 폰에서 `https://<계정>.github.io/vampire-survivor-wiki/` 접속.
3. 상단 배지가 **오프라인 OK** 가 될 때까지 기다린다(전체 파일 프리캐시 완료 신호).
4. iPhone: Safari 공유 → **홈 화면에 추가**. Android: Chrome 메뉴 → 앱 설치.
5. 이후 비행기 모드에서 홈 화면 아이콘으로 연다.

iOS는 홈 화면에 설치한 앱의 캐시는 지우지 않는다(일반 Safari 탭은 7일 미사용 시 삭제될 수 있음).
탑승 전 한 번 온라인으로 열어 배지가 초록인지 확인하는 게 안전하다.

## 3. 다른 게임 추가 (예: 하트골드)

`scraper/sites/<game>.json` 하나 추가:

```json
{
  "id": "hgss",
  "title": "포켓몬스터 하트골드·소울실버",
  "emoji": "🔥",
  "base": "https://namu.wiki",
  "seeds": ["/w/포켓몬스터 하트골드·소울실버"],
  "include": ["^/w/포켓몬스터 하트골드·소울실버(/|$)"],
  "exclude": [],
  "maxPages": 150
}
```

- `seeds`: 시작 문서. `include`/`exclude`: 따라갈 링크 범위(정규식, 디코드된 경로 기준).
- 범위 밖 링크는 나무위키 원문으로 가는 온라인 전용 링크(↗)로 남는다.
- `npm run scrape -- --site hgss && npm run build` → 홈 화면에 책이 하나 더 생긴다.

## 4. 구조

```
scraper/scrape.mjs     Playwright 크롤러: 본문 추출·정리, 이미지 다운로드, 내부 링크 → wiki:// 플레이스홀더
scraper/build.mjs      docs/ 생성: 링크 해석(리다이렉트 별칭 포함), 템플릿, 검색 색인, SW 프리캐시 목록
scraper/app/           PWA 셸(템플릿, CSS/JS, 서비스워커, manifest, 아이콘)
scraper/sites/*.json   책(book) 설정
test/fixture/          가짜 나무위키 서버 (npm test 용)
test/pwa-check.mjs     SW 설치 → 오프라인 전환 → 전 문서 열림·이미지·검색 검증
```

테스트: `npm test` (fixture 서버로 크롤 → 빌드 → 헤드리스 오프라인 검증).

나무위키 본문 DOM이 바뀌어 추출이 비면 `--debug` 로 전체 HTML을 `data/raw/<site>/debug/`에 떨궈 셀렉터(`extractInBrowser`)를 맞추면 된다.

라이선스: 긁어온 본문은 나무위키 CC BY-NC-SA 2.0 KR. 개인 열람용.
