#!/bin/bash
# 一括ページスクリーンショット ツールのラッパー
exec node "$(dirname "$0")/screenshot.mjs" "$@"
