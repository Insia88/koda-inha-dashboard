#!/usr/bin/env bash
# 개발 서버(기본 4300) 종료: 해당 포트를 듣는 프로세스만 종료한다.
PORT=${1:-4300}
for pid in $(netstat -ano | grep -E "127.0.0.1:${PORT}\s.*LISTENING" | awk '{print $5}' | sort -u); do
  cmd //c "taskkill /PID $pid /F /T" >/dev/null 2>&1 && echo "stopped $pid"
done
