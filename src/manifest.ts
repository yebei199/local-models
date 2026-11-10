// What each model host installs: pinned code, locked Python environments and pinned weights.

/** A git checkout at one commit; never a branch, so two hosts run the same code. */
export interface Checkout {
  repository: string;
  revision: string;
}

/** Hugging Face files at one commit. Keys are repository paths, values destinations relative to the
 * component directory. A key ending in `/`, or the empty key, selects a whole subtree; a destination
 * ending in `/` is a directory that keeps the rest of the path (a file's own name). */
export interface Weights {
  repository: string;
  revision: string;
  files: Record<string, string>;
}

export interface Component {
  code?: Checkout;
  /** A venv built from `locks/<lock>.txt`, the frozen environment the component was verified in. */
  python?: { version: string; lock: string; index?: string };
  /** Run from another component's checkout and venv instead of owning one. */
  base?: Name;
  /** Installed with --no-deps into the component's own `packages/`, ahead of the base venv. */
  packages?: string[];
  /** ComfyUI custom nodes, checked out under `data/custom_nodes/<name>`. */
  nodes?: Record<string, Checkout>;
  weights: Weights[];
}

export const engineNames = ['breeze', 'qwen', 'irodori', 'ming', 'ming-tiny'] as const;
export type Engine = (typeof engineNames)[number];
export type Name = 'comfyui' | Engine;

const cu128 = 'https://download.pytorch.org/whl/cu128';
const cu130 = 'https://download.pytorch.org/whl/cu130';
const comfyModels = (file: string, to: string) => ({ [file]: `data/models/${to}` });

export const manifest: Record<Name, Component> = {
  comfyui: {
    // v0.45.0, the first release with MiniMax-H3-Image.
    code: {
      repository: 'https://github.com/comfyanonymous/ComfyUI.git',
      revision: '989d93d0d968e704c589ce0146bb18c77f6b50cc',
    },
    // cu130 is required: comfy/quant_ops.py turns comfy-kitchen's CUDA backend off below CUDA 13,
    // and NVFP4 weights then run on eager PyTorch kernels, slower than fp8.
    python: { version: '3.12', lock: 'comfyui', index: cu130 },
    nodes: {
      'ComfyUI-GGUF': {
        repository: 'https://github.com/city96/ComfyUI-GGUF.git',
        revision: '6ea2651e7df66d7585f6ffee804b20e92fb38b8a',
      },
    },
    weights: [
      {
        repository: 'Comfy-Org/Flux-2-Klein-9B',
        revision: '1138ce884c8e977cdacacbe779784fec4426bb3f',
        files: {
          ...comfyModels('split_files/vae/flux2-vae.safetensors', 'vae/'),
          ...comfyModels(
            'split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors',
            'text_encoders/',
          ),
        },
      },
      {
        repository: 'unsloth/FLUX.2-klein-9B-GGUF',
        revision: '6db9b2d0479c98795589c94c9beef5cc818c6966',
        files: comfyModels('flux-2-klein-9b-Q8_0.gguf', 'unet/'),
      },
      {
        repository: 'Comfy-Org/MiniMax-H3',
        revision: '54472221d27c695fca9621b0c3ed52f06c4af707',
        files: {
          ...comfyModels('vae/minimax_h3_video_vae_fp16.safetensors', 'vae/'),
          ...comfyModels('vae/minimax_h3_audio_vae_fp32.safetensors', 'vae/'),
          ...comfyModels(
            'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
            'text_encoders/',
          ),
        },
      },
      {
        // Text-to-video and first-frame video use FL2VA; the reference workflow needs Ref2VA.
        repository: 'Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot',
        revision: '908eccad7e68751190d04c171956f163bfeed741',
        files: {
          ...comfyModels('MiniMax_H3_FL2VA_pruned_nvfp4.safetensors', 'diffusion_models/'),
          ...comfyModels('MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors', 'diffusion_models/'),
        },
      },
    ],
  },
  breeze: {
    code: {
      repository: 'https://github.com/breezeblue-ai/breeze-tts.git',
      revision: 'daa6cb2efe5471f09369229f322d20bb956cb3c3',
    },
    python: { version: '3.12', lock: 'breeze' },
    weights: [
      {
        repository: 'BreezeBlue/Breeze-TTS-2',
        revision: '3e28c5151381a722f1d8661b4118c298caa77aa4',
        files: { '': 'weights/' },
      },
    ],
  },
  qwen: {
    python: { version: '3.12', lock: 'qwen', index: cu130 },
    weights: [
      {
        repository: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
        revision: 'fd4b254389122332181a7c3db7f27e918eec64e3',
        files: { '': 'weights/' },
      },
    ],
  },
  irodori: {
    code: {
      repository: 'https://github.com/Aratako/Irodori-TTS.git',
      revision: '382205679ebc32295b7d1bfb329327d04c8f4eed',
    },
    python: { version: '3.10', lock: 'irodori', index: cu128 },
    weights: [
      {
        // The runtime looks for the tokenizer next to the checkpoint.
        repository: 'Aratako/Irodori-TTS-v4.1-Small',
        revision: '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b',
        files: { 'model.safetensors': 'weights/', 'tokenizer/': 'weights/tokenizer/' },
      },
      {
        repository: 'Aratako/Semantic-DACVAE-Japanese-32dim',
        revision: '47376ee24834d7a05a48ebabfe3cde29b3c5e214',
        files: { 'weights.pth': 'weights/codec.pth' },
      },
    ],
  },
  ming: {
    code: {
      repository: 'https://github.com/inclusionAI/Ming-3.0-tts.git',
      revision: 'a39b80660bdc5a4394d5e1d41af6dbfd9c443a54',
    },
    python: { version: '3.10', lock: 'ming', index: cu128 },
    weights: [
      {
        repository: 'inclusionAI/Ming-3.0-tts-0.5B',
        revision: '7247f4c94a5b2e987404ed28a5cfec41b1a4ca61',
        files: { '': 'weights/' },
      },
    ],
  },
  'ming-tiny': {
    // tiny pins an x-transformers that conflicts with the 0.5B model, so it shares Ming's checkout
    // and venv but puts its own copies first on PYTHONPATH.
    base: 'ming',
    packages: ['x-transformers==2.7.4', 'fla-core==0.4.2'],
    weights: [
      {
        repository: 'inclusionAI/Ming-3.0-tts-tiny',
        revision: '4715ef5a2f02901f75687d538b6920fd0dd11e6b',
        files: { '': 'weights/' },
      },
    ],
  },
};

/** Where a component lives under the install root; a component with a base runs that base's code. */
export function paths(models: string, name: Name) {
  const root = `${models}/${name}`;
  const owner = `${models}/${manifest[name].base ?? name}`;
  return {
    root,
    code: `${owner}/code`,
    venv: `${owner}/venv`,
    python: `${owner}/venv/bin/python`,
    packages: `${root}/packages`,
    weights: `${root}/weights`,
    data: `${root}/data`,
  };
}
