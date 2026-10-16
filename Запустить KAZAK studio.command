#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null; then
  print 'Для запуска нужен Node.js 22 или новее: https://nodejs.org/'
  read 'reply?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
if [[ ! -f node_modules/ffmpeg-static/ffmpeg ]]; then
  print 'Устанавливаем локальные инструменты для монтажа…'
  npm ci --omit=dev
fi
node launch.mjs
