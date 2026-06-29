# 메일 스팸 정리기

Gmail, Naver Mail, Nate Mail, 중앙대학교(M365) 이메일의 광고·스팸 메일을 자동으로 분류·정리하는 도구입니다.
CLI 터미널 모드와 Electron 데스크톱 앱(React 웹 UI 포함) 두 가지 방식으로 사용할 수 있습니다.

---

## 지원 이메일 서비스

| 서비스 | 인증 방식 | 비고 |
|---|---|---|
| Gmail | OAuth2 (Google API) | `credentials.json` + `token.json` |
| Naver Mail | IMAP (앱 비밀번호) | 실행 시 터미널 직접 입력 |
| Nate Mail | IMAP (아이디/비밀번호) | 실행 시 터미널 직접 입력 |
| 중앙대학교 (CAU) | Microsoft Graph API (MSAL) | Azure 앱 자격증명 필요 |

---

## 주요 기능

- **자동 분류** — 보안·결제·배송·계정 메일을 카테고리 폴더로 자동 이동
- **광고·스팸 정리** — 미리보기(dry-run) → 휴지통 이동 → 영구 삭제 순서로 안전하게 진행
- **스팸 처리** — 스팸으로 표시 / 발신자 차단
- **자동 필터 설정** — Gmail 전용, 광고 메일 재발 방지 필터 등록
- **이전 폴더 정리** — Naver 전용, 잘못 생성된 폴더 자동 복구 후 재분류

---

## 프로젝트 구조

```
Email-spam-cleaner/
├── src/
│   ├── index.js          # CLI 메인 진입점
│   ├── gmail/            # Gmail (OAuth2 + Gmail API)
│   │   ├── auth.cli.js   # CLI 인증 흐름
│   │   ├── auth.web.js   # 웹 인증 흐름
│   │   ├── client.js     # Gmail API 래퍼
│   │   ├── queries.js    # 삭제 대상 검색 쿼리
│   │   ├── cleaner.js    # 휴지통 이동 / 영구 삭제
│   │   ├── spammer.js    # 스팸 처리 / 발신자 차단
│   │   ├── filters.js    # 자동 필터 설정
│   │   └── categorizer.js# 카테고리 자동 분류
│   ├── naver/            # Naver Mail (IMAP)
│   ├── nate/             # Nate Mail (IMAP)
│   ├── cau/              # 중앙대학교 M365 (Microsoft Graph)
│   └── api/
│       └── routes/       # Express API 라우트 (auth / mail / logs)
├── electron/
│   ├── main.js           # Electron 메인 프로세스 (트레이 아이콘, 서버 제어)
│   ├── preload.js        # IPC 브릿지
│   └── window.html       # 데스크톱 앱 UI
├── client/               # React 프론트엔드 (Vite)
├── server.js             # Express 웹 서버 (포트 3005)
├── .env.example          # 환경변수 템플릿
└── package.json
```

---

## 설치 및 실행

### 사전 요구사항

- Node.js 18 이상
- Gmail 사용 시: Google Cloud Console에서 OAuth2 자격증명 발급

### 새 환경에서 빠른 시작 (Windows)

`setup.bat`을 더블클릭하면 아래 과정이 자동으로 진행됩니다.

1. Node.js 설치 여부 확인
2. `npm install` (루트 + client 디렉토리)
3. 바탕화면에 **"Mail Spam Cleaner"** 실행 아이콘 생성

이후 바탕화면 아이콘을 더블클릭하면 Electron 앱이 실행됩니다.

### 수동 설치

```bash
npm install
cd client && npm install
```

### 환경변수 설정

```bash
cp .env.example .env
# .env 파일을 열어 필요한 값 입력
```

### Gmail 인증 설정

1. [Google Cloud Console](https://console.cloud.google.com) 접속
2. 프로젝트 생성 → Gmail API 활성화
3. OAuth 2.0 클라이언트 ID 생성 (데스크톱 앱)
4. JSON 다운로드 후 `credentials.json`으로 저장 (프로젝트 루트)

### Naver Mail IMAP 설정

`mail.naver.com` → 환경설정 → POP3/IMAP 설정 → **IMAP 사용함** 체크

---

## 실행 방법

### CLI 모드 (터미널)

```bash
npm start          # 인터랙티브 메뉴
npm run dry-run    # 삭제 없이 대상 메일 미리보기
```

### 웹 UI 모드 (개발)

```bash
npm run dev        # Express 서버(3005) + React(5174) 동시 실행
```

### Electron 데스크톱 앱

```bash
npm run app        # 앱 실행 (트레이 아이콘 포함)
npm run app:build  # Windows 설치 파일 빌드 (.exe)
```

---

## 사용 흐름

```
실행 → 메일 서비스 선택 → 로그인 인증
  ↓
메뉴 선택:
  📂 자동 분류    — 보안/결제/배송/계정 폴더로 이동
  📋 미리보기     — 삭제 대상 메일 목록 확인 (변경 없음)
  🗑️  휴지통 이동  — 30일 이내 복구 가능
  ⚠️  영구 삭제   — "영구삭제" 문자 입력 후 확인
  🚫 스팸 처리   — 스팸함으로 이동
  🔒 발신자 차단
  ⚙️  자동 필터   — Gmail 전용
```

---

## 필터링 기준

| 삭제 대상 | 보존 대상 (삭제 금지) |
|---|---|
| 수신 동의 없는 광고성 메일 | 학교/직장 관련 메일 |
| 발신자 불명확한 스팸 | 금융·결제 확인 메일 |
| 읽지 않은 채 30일 이상 뉴스레터 | 계정 보안 관련 메일 |
| noreply / no-reply 자동 발송 | 직접 주고받은 개인 메일 |
| 프로모션/소셜 탭 미열람 메일 | |

---

## 보안 주의사항

- `credentials.json`, `token.json`, `.env`는 `.gitignore`에 포함되어 **절대 커밋되지 않습니다.**
- Naver / Nate 로그인 정보는 메모리에만 유지되며 프로그램 종료 시 사라집니다.
- 첫 실행 시 영구 삭제 대신 **휴지통 이동**으로 먼저 테스트하세요.

---

## 기술 스택

| 영역 | 기술 |
|---|---|
| 런타임 | Node.js |
| Gmail 연동 | googleapis (OAuth2) |
| IMAP 연동 | imapflow |
| CAU 연동 | @azure/msal-node + Microsoft Graph API |
| CLI UI | inquirer, ora, chalk, cli-table3 |
| 웹 서버 | Express 5, express-session, cors |
| 프론트엔드 | React (Vite) |
| 데스크톱 앱 | Electron + electron-builder |
