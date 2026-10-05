#!/usr/bin/env node
/**
 * Builds this Strapi app as a Docker image and optionally pushes it to a
 * container registry.
 *
 * Wraps `docker buildx build`, so a single run can produce a multi-platform
 * manifest list (linux/amd64 + linux/arm64) rather than one host-only image.
 *
 * Run:
 *   npm run build:image
 *   npm run build:image:push
 *   node scripts/docker/build-image.js --tag v1.2.3 --platform linux/amd64,linux/arm64
 *
 * Push target defaults to ghcr.io/nattaphong-ru-dotcom/69-s3-app. Authenticate
 * by setting GHCR_TOKEN to a classic PAT with `write:packages`, or by running
 * `docker login ghcr.io` once.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_IMAGE = 'nattaphong-ru-dotcom/69-s3-app';
const DEFAULT_PLATFORMS = ['linux/amd64', 'linux/arm64'];

// --- Argument parsing ------------------------------------------------------

const parseArgs = (argv) => {
  const options = {
    registry: DEFAULT_REGISTRY,
    image: DEFAULT_IMAGE,
    tag: null,
    platforms: null,
    aliasTags: [],
    push: false,
    load: false,
    noCache: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--registry':
        options.registry = next();
        break;
      case '--image':
        options.image = next();
        break;
      case '--tag':
      case '-t':
        options.tag = next();
        break;
      case '--platform':
        options.platforms = next().split(',').map((entry) => entry.trim()).filter(Boolean);
        break;
      case '--alias':
        options.aliasTags.push(next());
        break;
      case '--push':
        options.push = true;
        break;
      case '--load':
        options.load = true;
        break;
      case '--no-cache':
        options.noCache = true;
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'Usage: node scripts/docker/build-image.js [options]',
            '',
            '  -t, --tag <tag>          Image tag. Defaults to the git branch or short SHA.',
            '      --alias <tag>        Extra tag to apply to the same image. Repeatable.',
            '      --platform <list>    Comma-separated platforms. Defaults to',
            `                           ${DEFAULT_PLATFORMS.join(',')}.`,
            `      --registry <host>    Registry host. Defaults to ${DEFAULT_REGISTRY}.`,
            `      --image <path>       Image path. Defaults to ${DEFAULT_IMAGE}.`,
            '      --push               Push the result to the registry.',
            '      --load               Load a single-platform build into the local daemon.',
            '      --no-cache           Ignore cached layers.',
          ].join('\n')
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.load && options.platforms && options.platforms.length > 1) {
    throw new Error('--load only works with a single platform. Drop --load or pass one --platform.');
  }

  return options;
};

// --- Helpers ---------------------------------------------------------------

const run = (command, args, stdin) => {
  const useStdin = stdin !== undefined;
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: useStdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    ...(useStdin ? { input: stdin } : {}),
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const capture = (command, args) => {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
};

const inGitHubActions = () =>
  Boolean(process.env.ACTIONS_CACHE_URL && process.env.ACTIONS_RUNTIME_TOKEN);

// Docker tags accept [a-zA-Z0-9_][a-zA-Z0-9._-]*, and GHCR paths must be
// lowercase, so normalise both instead of letting the push fail remotely.
const sanitizeTag = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase();

const resolveTag = () => {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) {
    throw new Error('Not a git repository, or git is unavailable. Pass --tag explicitly.');
  }

  if (branch === 'HEAD') {
    const sha = capture('git', ['rev-parse', '--short', 'HEAD']);
    return sha ? `sha-${sha}` : 'latest';
  }

  return sanitizeTag(branch);
};

const login = (registry, image) => {
  const token = process.env.GHCR_TOKEN;

  if (!token) {
    console.log('GHCR_TOKEN is not set, using the existing docker login session.');
    return;
  }

  // Prefer the image owner: that is the namespace being pushed to, and it can
  // differ from the git remote when publishing to another organisation.
  const remote = capture('git', ['remote', 'get-url', 'origin']);
  const repoOwner = remote ? remote.replace(/\.git$/, '').split(/[/\\]/).slice(-2)[0] : null;
  const username = process.env.GHCR_USERNAME || image.split('/')[0] || repoOwner || 'github-actions';

  console.log(`Logging in to ${registry} as ${username}`);
  // The token goes over stdin so it never lands in the process table.
  run('docker', ['login', registry, '--username', username, '--password-stdin'], `${token}\n`);
};

// --- Main ------------------------------------------------------------------

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const tag = sanitizeTag(options.tag || resolveTag());
  const platforms = options.platforms || DEFAULT_PLATFORMS;
  const imageRef = `${options.registry}/${options.image}`;

  const args = ['buildx', 'build', '--platform', platforms.join(','), '-t', `${imageRef}:${tag}`];

  if (options.noCache) {
    args.push('--no-cache');
  }

  // Only export a shared cache in CI. Outside Actions the builder keeps its own
  // layer cache, and exporting this image's layers to disk costs far more time
  // than it saves.
  if (inGitHubActions()) {
    args.push('--cache-from', `type=gha,scope=${tag}`, '--cache-to', `type=gha,mode=max,scope=${tag}`);
  }

  for (const alias of options.aliasTags) {
    args.push('-t', `${imageRef}:${sanitizeTag(alias)}`);
  }

  if (options.push) {
    args.push('--push');
  } else if (options.load) {
    args.push('--load');
  }

  args.push('.');

  if (options.push) {
    login(options.registry, options.image);
  }

  console.log(`Building ${imageRef}:${tag} for ${platforms.join(', ')}`);
  console.log(`Context: ${PROJECT_ROOT}`);

  run('docker', args);

  console.log('');

  if (options.push) {
    const digest = capture('docker', [
      'buildx',
      'imagetools',
      'inspect',
      `${imageRef}:${tag}`,
      '--format',
      '{{.Manifest.Digest}}',
    ]);

    console.log(`Pushed: ${imageRef}:${tag}`);
    if (digest) {
      console.log(`Digest: ${digest}`);
    }
    console.log(`Pull with: docker pull ${imageRef}:${tag}`);
  } else {
    console.log(`Built: ${imageRef}:${tag}`);
    if (!options.load) {
      console.log('Nothing was pushed or loaded. Pass --push or --load to do something with it.');
    }
  }
};

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}