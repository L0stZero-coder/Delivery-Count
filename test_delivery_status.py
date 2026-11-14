import json
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import date, timedelta
from pathlib import Path
from urllib.request import build_opener, ProxyHandler, Request
from urllib.error import HTTPError


class DeliveryStatusTests(unittest.TestCase):
    def test_status_workflow_and_migration(self):
        today = date.today().isoformat()
        future = (date.today() + timedelta(days=3)).isoformat()
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'test.sqlite3'
            db = sqlite3.connect(database)
            db.execute('CREATE TABLE deliveries(id INTEGER PRIMARY KEY, arrival TEXT NOT NULL, boxes INTEGER NOT NULL)')
            db.executemany('INSERT INTO deliveries VALUES (?, ?, ?)', [(1, today, 69), (2, future, 80)])
            db.commit()
            db.close()
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            opener = build_opener(ProxyHandler({}))
            def request(path, data=None):
                req = Request(f'http://127.0.0.1:{port}' + path,
                              data=json.dumps(data).encode() if data is not None else None,
                              headers={'Content-Type': 'application/json'})
                try:
                    with opener.open(req, timeout=2) as response:
                        return response.status, json.load(response)
                except HTTPError as error:
                    with error:
                        return error.code, json.load(error)
            def start():
                process = subprocess.Popen([sys.executable, 'server.py', '--host', '127.0.0.1', '--port', str(port), '--database', str(database)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for _ in range(40):
                    try:
                        request('/api/deliveries')
                        return process
                    except OSError:
                        time.sleep(.1)
                process.terminate(); process.wait()
                self.fail('Test server did not start')
            process = start()
            try:
                deliveries = request('/api/deliveries')[1]['deliveries']
                self.assertEqual({d['id']: d['status'] for d in deliveries}, {1: 'arrived', 2: 'expected'})
                # Simulate an expected delivery reaching its due date without confirmation.
                db = sqlite3.connect(database)
                db.execute('UPDATE deliveries SET arrival=? WHERE id=2', (today,))
                db.execute("INSERT INTO products VALUES (1, 'case', 'model', 'black', 'Case', 'Model', 'Black')")
                db.execute("INSERT INTO delivery_lines VALUES (2, 1, 50, 'A1', '001', '{}')")
                db.commit(); db.close()
                process.terminate(); process.wait()
                process = start()
                self.assertEqual(request('/api/history')[1]['rows'][0]['status'], 'expected')
                payload = dict(status='delayed', arrival=today, previous_status='expected', previous_arrival=today)
                self.assertEqual(request('/api/deliveries/2/status', payload)[0], 400)
                payload['arrival'] = future
                self.assertEqual(request('/api/deliveries/2/status', payload)[0], 200)
                self.assertEqual(request('/api/deliveries/2/status', payload)[0], 409)
                row = request('/api/history')[1]['rows'][0]
                self.assertEqual((row['status'], row['arrival'], row['qty']), ('delayed', future, 50))
                payload = dict(status='arrived', arrival=today, previous_status='delayed', previous_arrival=future)
                self.assertEqual(request('/api/deliveries/2/status', payload)[0], 200)
                self.assertEqual(request('/api/history')[1]['rows'][0]['status'], 'arrived')
                activity = request('/api/activity')[1]['activity'][0]
                self.assertEqual(activity['kind'], 'status')
                self.assertEqual(request(f"/api/activity/{activity['id']}/undo", {})[0], 200)
                row = request('/api/history')[1]['rows'][0]
                self.assertEqual((row['status'], row['arrival']), ('delayed', future))
            finally:
                process.terminate(); process.wait()


if __name__ == '__main__':
    unittest.main()
