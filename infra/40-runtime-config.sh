#!/bin/sh
set -eu
case "${RHTV_MODE:-service}" in preview|service) ;; *) echo "Invalid runtime mode" >&2; exit 1 ;; esac
case "${RHTV_EDITION:-internal}" in
  internal) feature_default=false ;;
  external) feature_default=true ;;
  *) echo "Invalid runtime edition" >&2; exit 1 ;;
esac
feature_bool() {
  case "$1" in
    '') printf '%s' "$feature_default" ;;
    true|false) printf '%s' "$1" ;;
    *) echo "Feature overrides must be true or false" >&2; exit 1 ;;
  esac
}
community=$(feature_bool "${FEATURE_COMMUNITY:-}")
billing=$(feature_bool "${FEATURE_BILLING:-}")
sharing=$(feature_bool "${FEATURE_PUBLIC_SHARING:-}")
marketing=$(feature_bool "${FEATURE_MARKETING:-}")
links=$(feature_bool "${FEATURE_EXTERNAL_LINKS:-}")
# This public file intentionally contains only non-secret application settings.
printf 'window.__RHTV_RUNTIME_CONFIG__={mode:"%s",edition:"%s",apiBase:"/api/v1",catalogMode:"sample-snapshot",features:{community:%s,billing:%s,publicSharing:%s,marketing:%s,externalLinks:%s}};\n' \
  "${RHTV_MODE:-service}" "${RHTV_EDITION:-internal}" "$community" "$billing" "$sharing" "$marketing" "$links" \
  > /usr/share/nginx/html/runtime-config.js
