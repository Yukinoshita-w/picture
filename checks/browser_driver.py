"""Minimal Chrome DevTools driver using Python stdlib; shared by whiteboard checks."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import time
OUTPUT = Path(__file__).resolve().parents[1] / "test-results"


class DevTools:
    def __init__(self, url):
        from urllib.parse import urlparse
        parsed = urlparse(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        request = f'GET {parsed.path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
        self.sock.sendall(request.encode())
        response = b''
        while not response.endswith(b'\r\n\r\n'):
            response += self.sock.recv(1)
        if not response.startswith(b'HTTP/1.1 101 '):
            raise RuntimeError(response.decode())
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert expected in response
        self.next_id = 0
        self.errors = []
        self.log_errors = []

    def read(self, size):
        data = b''
        while len(data) < size:
            part = self.sock.recv(size - len(data))
            if not part:
                raise RuntimeError('Browser connection closed')
            data += part
        return data

    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        length = len(payload)
        header = bytes([0x80 | opcode])
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack('!H', length)
        else:
            header += bytes([0x80 | 127]) + struct.pack('!Q', length)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def receive(self):
        parts = []
        while True:
            first, second = self.read(2)
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            mask = self.read(4) if second & 128 else None
            payload = self.read(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            opcode = first & 15
            if opcode == 9:
                self.send(payload, 10)
                continue
            if opcode == 8:
                raise RuntimeError('WebSocket closed')
            parts.append(payload)
            if first & 128:
                return json.loads(b''.join(parts))

    def call(self, method, params=None):
        self.next_id += 1
        task_id = self.next_id
        self.send(json.dumps({'id': task_id, 'method': method, 'params': params or {}}).encode())
        while True:
            message = self.receive()
            if message.get('method') == 'Runtime.exceptionThrown':
                self.errors.append(message['params'])
            if message.get('method') == 'Log.entryAdded':
                entry = message['params']['entry']
                if entry.get('level') == 'error' and 'favicon' not in entry.get('url', ''):
                    self.log_errors.append(entry)
            if message.get('id') == task_id:
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message.get('result', {})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if result.get('exceptionDetails'):
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

    def until(self, expression, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.evaluate(expression):
                return
            time.sleep(.15)
        raise AssertionError('Timed out: ' + expression)

    def screenshot(self, filename):
        self.call('Page.bringToFront')
        data = self.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        (OUTPUT / filename).write_bytes(base64.b64decode(data['data']))

