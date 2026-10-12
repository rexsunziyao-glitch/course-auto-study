#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
网课挂机助手 · 扩展装载器（Python 版，纯标准库）

macOS 上不一定有 node，但往往有 python3。这个版本不依赖任何第三方包，
自己实现了最小的 WebSocket 客户端，专门用来跟 Chrome 的调试端口说一句话：
「把这个文件夹里的扩展装进去」。

用法：
    python3 cdp-load.py <扩展目录> [端口]     # 装载扩展
    python3 cdp-load.py --version [端口]      # 自检（只读，不改任何状态）

退出码：0 = 成功/已装载   1 = 失败   2 = 参数错误
"""

import base64
import json
import os
import socket
import struct
import sys
import urllib.request

# ---------------------------------------------------------------- HTTP
def http_json(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- WebSocket
def ws_open(ws_url):
    """完成 WebSocket 握手，返回已连接的 socket"""
    if not ws_url.startswith("ws://"):
        raise ValueError("只支持本地 ws:// 地址")
    rest = ws_url[5:]
    hostport, _, path = rest.partition("/")
    if ":" in hostport:
        host, _, port_s = hostport.partition(":")
    else:
        host, port_s = hostport, "80"

    s = socket.create_connection((host, int(port_s)), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        "GET /%s HTTP/1.1\r\n" % path
        + "Host: %s\r\n" % hostport
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "Sec-WebSocket-Key: %s\r\n" % key
        + "Sec-WebSocket-Version: 13\r\n"
        + "\r\n"
    )
    s.sendall(req.encode("ascii"))

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("握手过程中连接被关闭")
        buf += chunk
        if len(buf) > 65536:
            raise RuntimeError("握手响应异常")

    head = buf.split(b"\r\n", 1)[0].decode("latin-1")
    if "101" not in head:
        raise RuntimeError("握手被拒绝: " + head)
    return s


def ws_send(sock, text):
    """发送一个客户端掩码文本帧"""
    data = text.encode("utf-8")
    n = len(data)
    hdr = bytearray([0x81])
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126)
        hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127)
        hdr += struct.pack(">Q", n)
    mask = os.urandom(4)
    hdr += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(bytes(hdr) + masked)


def _recv_exact(sock, n):
    out = b""
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise RuntimeError("连接已关闭")
        out += chunk
    return out


def ws_recv(sock):
    """读一个完整消息（自动处理分片与掩码）"""
    payload = b""
    while True:
        h = _recv_exact(sock, 2)
        fin = h[0] & 0x80
        opcode = h[0] & 0x0F
        length = h[1] & 0x7F

        if length == 126:
            length = struct.unpack(">H", _recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", _recv_exact(sock, 8))[0]

        if h[1] & 0x80:                       # 服务端一般不加掩码，但以防万一
            mask = _recv_exact(sock, 4)
            data = _recv_exact(sock, length) if length else b""
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        else:
            data = _recv_exact(sock, length) if length else b""

        if opcode == 0x8:
            raise RuntimeError("服务端关闭了连接")
        if opcode == 0x9:                     # ping → 忽略，继续读
            continue

        payload += data
        if fin:
            break
    return payload


def cdp_call(port, method, params=None):
    """在浏览器级目标上调用一个 CDP 方法"""
    version = http_json("http://127.0.0.1:%s/json/version" % port)
    ws_url = version.get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError("拿不到 webSocketDebuggerUrl")

    sock = ws_open(ws_url)
    try:
        ws_send(sock, json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws_recv(sock).decode("utf-8"))
            if msg.get("id") == 1:
                return msg
    finally:
        try:
            sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 主流程
def main():
    args = sys.argv[1:]
    if not args:
        print("用法: cdp-load.py <扩展目录> [端口]", file=sys.stderr)
        return 2

    if args[0] == "--version":
        port = args[1] if len(args) > 1 else "9222"
        try:
            r = cdp_call(port, "Browser.getVersion")
            print("OK " + r.get("result", {}).get("product", "?"))
            return 0
        except Exception as e:
            print("FAIL " + str(e), file=sys.stderr)
            return 1

    ext_path = os.path.abspath(args[0])
    port = args[1] if len(args) > 1 else "9222"

    if not os.path.isdir(ext_path):
        print("FAIL 扩展目录不存在: " + ext_path, file=sys.stderr)
        return 2

    try:
        r = cdp_call(port, "Extensions.loadUnpacked", {"path": ext_path})
    except Exception as e:
        print("FAIL " + str(e), file=sys.stderr)
        return 1

    if r.get("error"):
        s = json.dumps(r["error"], ensure_ascii=False)
        low = s.lower()
        if "already" in low or "duplicate" in low or "exists" in low or "loaded" in low:
            print("ALREADY 扩展此前已装载")
            return 0
        print("FAIL " + s, file=sys.stderr)
        return 1

    print("OK 扩展已装载，ID = " + str((r.get("result") or {}).get("id")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
