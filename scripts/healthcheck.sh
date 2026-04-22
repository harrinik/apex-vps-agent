#!/usr/bin/env bash
# Docker / PM2 healthcheck script
set -e
wget -qO- http://localhost:3001/health/live > /dev/null