#!/bin/bash
# 재부팅 시 cron(@reboot)이 이 스크립트로 서버를 자동 실행합니다.
cd "$(dirname "$0")"
mkdir -p logs
exec node server.js >> logs/server.log 2>&1
