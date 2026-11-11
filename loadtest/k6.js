import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<300'],
    http_req_failed: ['rate<0.01'],
  },
  vus: 1000,
  duration: '10m',
};

export default function () {
  const res = http.post('http://localhost:3000/api/start-process');
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}