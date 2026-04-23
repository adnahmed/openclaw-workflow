import { spawn } from 'node:child_process';

const cachedOpenClawPath = 'C:\\Users\\Adnan\\AppData\\Roaming\\nvm\\openclaw.ps1';
const args = ['cron', 'runs', '--json'];

console.log(`Testing simple spawn with -File: ${cachedOpenClawPath}`);
const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', cachedOpenClawPath, ...args]);

child.stdout.on('data', (data) => console.log('STDOUT:', data.toString()));
child.stderr.on('data', (data) => console.error('STDERR:', data.toString()));
child.on('close', (code) => console.log('Closed with code:', code));
