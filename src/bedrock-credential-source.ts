import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ClaudeBedrockEnv } from './providers/claude-code-jobs.js';

const KEYS = ['CLAUDE_CODE_USE_BEDROCK','AWS_REGION','AWS_DEFAULT_REGION','AWS_PROFILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN'] as const;
/** One owner-controlled source reference; never copies credentials into a registry. */
export async function loadBedrockCredentialSource(path?: string): Promise<ClaudeBedrockEnv> {
  const env: ClaudeBedrockEnv = {};
  if (path) {
    if (!path.startsWith('/')) throw new Error('bedrock_credential_source_invalid');
    const info=await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid?.() || (info.mode & 0o077)!==0 || info.size>131072) throw new Error('bedrock_credential_source_invalid');
    const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat=await file.stat(); if(stat.ino!==info.ino || stat.dev!==info.dev)throw new Error('bedrock_credential_source_invalid');
      const raw=await file.readFile();if(raw.length>131072)throw new Error('bedrock_credential_source_invalid');
      const data=JSON.parse(raw.toString('utf8'));
      for(const key of KEYS)if(typeof data?.env?.[key]==='string')env[key]=data.env[key];
    } finally {await file.close();}
  }
  for(const key of KEYS)if(process.env[key]!==undefined)env[key]=process.env[key];
  if(env.AWS_ACCESS_KEY_ID && !env.AWS_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY && !env.AWS_ACCESS_KEY_ID)throw new Error('bedrock_credential_pair_incomplete');
  env.CLAUDE_CODE_USE_BEDROCK='1';
  return env;
}
