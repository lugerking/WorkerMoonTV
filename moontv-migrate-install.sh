#!/bin/bash
# MoonTV 一键迁移部署脚本（新服务器执行，适配 Alibaba Cloud Linux 3 / CentOS 系）
# 用法：把 moontv-migrate.tgz 和本脚本放到新服务器同一目录，root 执行：
#   bash moontv-migrate-install.sh
set -e
TGZ="$(dirname "$(readlink -f "$0")")/moontv-migrate.tgz"

echo "=== 1. 安装依赖（Node 20 / redis / nginx） ==="
dnf install -y -q redis nginx curl 2>&1 | tail -2
if ! command -v node > /dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>&1 | tail -1
  dnf install -y -q nodejs 2>&1 | tail -1
fi
node -v
# 旧服务器 node 路径兼容：systemd 单元用 /usr/local/node/bin/node
mkdir -p /usr/local/node/bin
ln -sf "$(command -v node)" /usr/local/node/bin/node

echo "=== 2. 创建运行用户 moontv ==="
id moontv > /dev/null 2>&1 || useradd --system --home /opt/moontv --shell /sbin/nologin moontv

echo "=== 3. 停旧服务（若有） ==="
systemctl stop moontv moontv-cron.timer 2>/dev/null || true
systemctl stop redis 2>/dev/null || true

echo "=== 4. 解包应用与配置 ==="
tar --exclude="opt/moontv/cache" -C / -xzf "$TGZ"
mkdir -p /var/lib/redis
tar -C /var/lib/redis -xzf /tmp/migrate/redis-data.tgz 2>/dev/null || true
chown -R redis:redis /var/lib/redis
# 恢复 Redis 密码（与 /etc/moontv.env 的 REDIS_URL 一致，保证数据与认证无缝）
RP=$(grep -oE "redis://:[^@]+@" /etc/moontv.env | head -1 | sed "s|redis://:||;s|@$||")
RCONF=/etc/redis.conf
[ -f /etc/redis/redis.conf ] && RCONF=/etc/redis/redis.conf
if [ -n "$RP" ]; then
  sed -i "s/^# *requirepass .*/requirepass $RP/" "$RCONF"
  grep -q "^requirepass" "$RCONF" || echo "requirepass $RP" >> "$RCONF"
fi
chown -R moontv:moontv /opt/moontv

echo "=== 5. 安装 systemd 单元与 nginx ==="
cp /tmp/migrate/moontv.service /tmp/migrate/moontv-cron.service /tmp/migrate/moontv-cron.timer /etc/systemd/system/
mkdir -p /etc/nginx/ssl /etc/nginx/conf.d
cp -a /tmp/migrate/ssl/* /etc/nginx/ssl/
cp -a /tmp/migrate/conf.d/*.conf /etc/nginx/conf.d/
nginx -t && systemctl enable --now nginx
systemctl daemon-reload

echo "=== 6. 启动 ==="
systemctl enable --now redis
systemctl enable --now moontv
systemctl enable --now moontv-cron.timer
sleep 3

echo "=== 7. 验证 ==="
systemctl is-active moontv redis nginx
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/login)
echo "local /login => $CODE (期望 200)"
CODE2=$(curl -sk -o /dev/null -w "%{http_code}" --resolve lhq666.cc.cd:443:127.0.0.1 https://lhq666.cc.cd/login)
echo "local nginx https => $CODE2 (期望 200)"
RPING=$(redis-cli -a "$RP" --no-auth-warning ping 2>/dev/null || echo none)
echo "redis ping => $RPING"
if [ "$CODE" = "200" ]; then
  echo "MIGRATE_OK"
else
  echo "服务未就绪，查看日志: journalctl -u moontv -n 50"
fi

echo "=== 8. 后续（助手可代办） ==="
echo "- Cloudflare DNS A 记录（lhq666.cc.cd）切换到本机公网 IP"
echo "- 安全组放行端口: 80 / 443"
