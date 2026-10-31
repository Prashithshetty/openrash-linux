#!/usr/bin/env python3
"""
OpenRash Embedded Server Benchmark
Measures loopback HTTP 206 Partial Content byte-range throughput and latency.
"""
import time
import urllib.request
import argparse

def benchmark(url, iterations=100):
    print(f"Benchmarking {url} ({iterations} requests)...")
    latencies = []
    req = urllib.request.Request(url, headers={"Range": "bytes=0-65535"})
    for i in range(iterations):
        t0 = time.perf_counter()
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
        latencies.append((time.perf_counter() - t0) * 1000.0)

    avg = sum(latencies) / len(latencies)
    min_lat = min(latencies)
    max_lat = max(latencies)
    print(f"Results: min={min_lat:.2f}ms, avg={avg:.2f}ms, max={max_lat:.2f}ms")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:33313/assets/video/start1.mp4")
    parser.add_argument("--count", type=int, default=50)
    args = parser.parse_args()
    try:
        benchmark(args.url, args.count)
    except Exception as e:
        print(f"Server offline or unreachable: {e}")
