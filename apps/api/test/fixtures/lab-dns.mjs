// Rebinding resolver for the opt-in real-engine abuse suite: a real UDP DNS server that answers
// every A query with the next address of the name's list (TTL 0). The last answer repeats.
//   LAB_DNS_RECORDS={"rebind.s8.test":["10.0.0.5","10.0.0.6"]}
// Every query is logged as `Q <name> <n>` so a test can count lookups through `docker logs`.
import { createSocket } from 'node:dgram';

const records = JSON.parse(process.env.LAB_DNS_RECORDS ?? '{}');
const seen = new Map();
const sock = createSocket('udp4');
sock.on('message', (msg, rinfo) => {
  let i = 12;
  const labels = [];
  while (msg[i] !== 0 && i < msg.length) {
    labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('ascii'));
    i += msg[i] + 1;
  }
  const end = i + 5; // zero byte, qtype, qclass
  const name = labels.join('.').toLowerCase();
  const qtype = msg.readUInt16BE(i + 1);
  const list = records[name];
  const head = Buffer.from(msg.subarray(0, 12));
  const question = msg.subarray(12, end);
  if (!list) {
    head.writeUInt16BE(0x8183, 2); // response, NXDOMAIN
    head.writeUInt16BE(0, 6);
    return sock.send(Buffer.concat([head, question]), rinfo.port, rinfo.address);
  }
  const n = (seen.get(name) ?? 0) + (qtype === 1 ? 1 : 0);
  seen.set(name, n);
  if (qtype === 1) process.stdout.write(`Q ${name} ${n}\n`);
  head.writeUInt16BE(0x8180, 2);
  head.writeUInt16BE(qtype === 1 ? 1 : 0, 6);
  const parts = [head, question];
  if (qtype === 1) {
    const ip = list[Math.min(Math.max(n, 1) - 1, list.length - 1)].split('.').map(Number);
    parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...ip]));
  }
  sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
sock.bind(53, '0.0.0.0');
