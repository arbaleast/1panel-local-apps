#!/bin/bash
# 1Panel 宿主机终端执行 — anirss 容器更新失败：172.21.0.0/16 bridge 路由冲突
# 按顺序跑，每段先看结果再决定下一步

set -e
echo "==== 1) 观察现状（不改任何东西）===="
docker network ls
echo "---"
docker network inspect 1panel-network --format '{{json .IPAM.Config}}' 2>/dev/null || echo "no 1panel-network"
echo "---"
docker network inspect bridge --format '{{json .IPAM.Config}}' 2>/dev/null || echo "no bridge"
echo "---"
# 关键证据：宿主路由表里 172.21.0.0/16 是不是已经存在
ip route | grep -E "172\.(21|17|18|19|20|22|23|24|25|26|27|28|29|30|31|32)\.0\.0"
echo "---"
cat /etc/docker/daemon.json 2>/dev/null || echo "(no daemon.json)"

echo
echo "==== 2) 判断 + 修复 ===="
echo
echo "A. 如果上面看到两条不同 ifindex 的 172.21.0.0/16（或 Src 一致但 Dst 重复）"
echo "   → 是 daemon 与 iptables/netlink 状态不一致，最快的修法是重启 docker："
echo "     sudo systemctl restart docker"
echo "   然后回 1Panel 面板重试「更新容器 anirss」"
echo
echo "B. 如果 1panel-network 自己 Subnet 就是 172.21.0.0/16 但有别的 docker 网络也叫这个名字"
echo "   残留了僵尸 veth / 旧 bridge："
echo "     sudo ip link show | grep -E 'veth|br-' | head -20"
echo "     sudo iptables -t nat -S | grep 172.21 | head -10"
echo "   看到残留条目：sudo iptables -t nat -D <chain> <rule-num>  逐条删"
echo
echo "C. 如果 docker0 不存在但有 '1panel-network' 多个重名/错乱："
echo "     docker network rm 1panel-network 2>/dev/null || true"
echo "     sudo systemctl restart docker"
echo "   然后在 1Panel 面板 → 应用商店 → 本地应用 → anirss → 重建"
echo
echo "D. 终极大招（保留数据）："
echo "     1) 1Panel 面板里先把 anirss 容器停掉"
echo "     2) sudo systemctl restart docker"
echo "     3) 1Panel 面板里再启动 anirss（不要走「更新」，走「启动」）"
echo "     这样能避开 update 路径里的 stop→rename→recreate 链路"

echo
echo "==== 3) 验证 ===="
docker ps -a --filter "name=anirss" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo "---"
# 在宿主机上 curl 测出口（注意：宿主机跟容器网络栈不同，结论仅作参考）
curl -sS -o /dev/null -w "mikanani.tv from HOST: HTTP=%{http_code} TIME=%{time_total}s\n" --max-time 10 https://mikanani.tv/ || true
