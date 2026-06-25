#!/usr/bin/env python3
"""开发用静态服务器: 禁用缓存, 保证每次刷新都拿到最新的 JS/HTML。"""
import http.server
import socketserver

PORT = 5510


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
        print(f'serving on http://localhost:{PORT} (no-cache)')
        httpd.serve_forever()
