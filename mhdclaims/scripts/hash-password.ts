// Prints the ADMIN_PASSWORD_HASH value for a password.
//
//   npm run hash-password                 prompts (input hidden), asks twice
//   echo -n 'pw' | npm run hash-password  reads the password from stdin
//   npm run hash-password -- 'pw'         from an argument (lands in shell history)
//
// In the production container: docker compose run --rm --no-deps app node dist/scripts/hash-password.js

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../src/web/admin-auth.js';

const MIN_LENGTH = 12;

// Reads one line from the terminal without echoing it.
function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  let password: string;
  const arg = process.argv[2];
  if (arg !== undefined) {
    password = arg;
  } else if (process.stdin.isTTY) {
    password = await promptHidden('Admin password: ');
    const again = await promptHidden('Repeat it: ');
    if (again !== password) {
      console.error('The passwords did not match.');
      return 1;
    }
  } else {
    password = await readStdin();
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Use at least ${MIN_LENGTH} characters.`);
    return 1;
  }
  console.log(await hashPassword(password));
  return 0;
}

process.exitCode = await main();
