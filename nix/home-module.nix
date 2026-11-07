# Home Manager 模块：命令和按需启动的单元。每台主机声明同样的单元，没装模型的主机靠 Condition 跳过。
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.local-models;
  inherit (lib) mkOption types;
  port =
    default:
    mkOption {
      type = types.port;
      inherit default;
    };
  package = pkgs.callPackage ./package.nix {
    environment = {
      TTS_HOST = cfg.host;
      TTS_PORT = toString cfg.tts.frontPort;
      COMFYUI_URL = cfg.comfyui.url;
      COMFYUI_DIR = cfg.comfyui.directory;
      CUDA_LIB = cfg.cudaLibraryPath;
    };
  };
  # 空闲后 proxyd 退出，后端随 StopWhenUnneeded 停下，显存才还回来。
  front = target: {
    ExecStart = "${pkgs.systemd}/lib/systemd/systemd-socket-proxyd --exit-idle-time=${cfg.idleTime} 127.0.0.1:${toString target}";
    PrivateTmp = true;
  };
  # 模型互斥占用显存，由 model-gate 逐个拉起，所以都只有一个私有端口。
  python = directory: "${directory}/.venv/bin/python";
  enginePort = toString cfg.tts.enginePort;
  cuda = {
    LD_LIBRARY_PATH = cfg.cudaLibraryPath;
    # NixOS 没有 /sbin/ldconfig，Triton 要靠它找 libcuda，否则 Qwen 首次合成就失败。
    TRITON_LIBCUDA_PATH = cfg.cudaLibraryPath;
    HF_HUB_OFFLINE = "1";
    TOKENIZERS_PARALLELISM = "false";
  };
  engines = {
    breeze = {
      inherit (cfg.tts) directory;
      command = [
        (python cfg.tts.directory)
        "-m"
        "breeze_infer.api"
        cfg.tts.modelDirectory
        "--host"
        "127.0.0.1"
        "--port"
        enginePort
      ];
      environment = cuda // {
        PATH = "${lib.makeBinPath [ pkgs.sox ]}:/run/current-system/sw/bin";
      };
      vram = cfg.tts.requiredVram;
    };
  }
  // lib.optionalAttrs (cfg.tts.qwen != null) {
    qwen = {
      inherit (cfg.tts.qwen) directory;
      command = [
        (python cfg.tts.qwen.directory)
        "${package.engines}/qwen.py"
        "--model"
        cfg.tts.qwen.modelDirectory
        "--port"
        enginePort
      ];
      environment = cuda;
      vram = cfg.tts.qwen.requiredVram;
    };
  }
  // lib.optionalAttrs (cfg.tts.irodori != null) {
    irodori = {
      inherit (cfg.tts.irodori) directory;
      command = [
        (python cfg.tts.irodori.directory)
        "${package.engines}/irodori.py"
        "--checkpoint"
        cfg.tts.irodori.checkpoint
        "--port"
        enginePort
      ];
      environment = cuda // {
        PYTHONPATH = cfg.tts.irodori.directory;
      };
      vram = cfg.tts.irodori.requiredVram;
    };
  }
  // lib.optionalAttrs (cfg.tts.ming != null) {
    ming = {
      inherit (cfg.tts.ming) directory;
      command = [
        (python cfg.tts.ming.directory)
        "${package.engines}/ming.py"
        "--model"
        cfg.tts.ming.modelDirectory
        "--port"
        enginePort
      ];
      environment = cuda // {
        PYTHONPATH = cfg.tts.ming.directory;
      };
      vram = cfg.tts.ming.requiredVram;
    };
  }
  // lib.optionalAttrs (cfg.tts.mingTiny != null) {
    ming-tiny = {
      inherit (cfg.tts.mingTiny) directory;
      command = [
        (python cfg.tts.mingTiny.directory)
        "${package.engines}/mingtiny.py"
        "--model"
        cfg.tts.mingTiny.modelDirectory
        "--bits"
        (toString cfg.tts.mingTiny.bits)
        "--port"
        enginePort
      ];
      environment = cuda // {
        # tiny 钉死的 x-transformers 和 0.5B 共用的 .venv 冲突，它独有的包放在前面覆盖。
        PYTHONPATH = "${cfg.tts.mingTiny.packages}:${cfg.tts.mingTiny.directory}";
        # 峰值显存是在这个设置下实测的，去掉它 requiredVram 就不再可信。
        PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True";
      };
      vram = cfg.tts.mingTiny.requiredVram;
    };
  };
  # 路由只保留已配置的模型，没装 Qwen、Irodori、Ming 或 tiny 的主机不会在启动时报错。
  routes = lib.mapAttrs (_: lib.filterAttrs (_: name: engines ? ${name})) cfg.tts.routes;
  gateConfig = pkgs.writeText "model-gate.json" (
    builtins.toJSON {
      inherit engines routes;
      enginePort = cfg.tts.enginePort;
      vramWait = 30;
      inherit (cfg.tts) voices;
    }
  );
  comfyCondition.ConditionPathIsDirectory = "${cfg.comfyui.directory}/ComfyUI";
  ttsCondition.ConditionPathIsDirectory = cfg.tts.directory;
  webCondition.ConditionPathIsDirectory = cfg.web.directory;
in
{
  options.services.local-models = {
    enable = lib.mkEnableOption "local model commands and on-demand services";
    host = mkOption {
      type = types.str;
      default = "";
      description = "Host that runs inference; empty means this machine.";
    };
    cudaLibraryPath = mkOption {
      type = types.str;
      default = "/run/opengl-driver/lib";
    };
    idleTime = mkOption {
      type = types.str;
      default = "30min";
      description = "Idle time after which a service exits and returns its VRAM.";
    };
    web = {
      directory = mkOption {
        type = types.str;
        default = "${config.xdg.dataHome}/local-models/web";
        description = "Pages to publish; hosts without this directory skip the service.";
      };
      # 刻意落在 tailnet-https 的 8000-8199：只绑回环，Caddy 给它 +10000 的 HTTPS 入口。
      port = port 8096;
    };
    comfyui = {
      directory = mkOption { type = types.str; };
      url = mkOption { type = types.str; };
      frontPort = port 8088;
      backendPort = port 8089;
    };
    tts = {
      directory = mkOption {
        type = types.str;
        description = "breeze-tts checkout whose .venv holds the service.";
      };
      modelDirectory = mkOption { type = types.str; };
      voices = mkOption {
        description = ''
          Fixed reference per use and language, read on the model host. A clone copies
          the reference's delivery, so narration and flashcards need different recordings.
        '';
        type = types.attrsOf (
          types.attrsOf (
            types.submodule {
              options = {
                path = mkOption { type = types.str; };
                text = mkOption {
                  type = types.str;
                  description = "Exact transcript of the reference audio.";
                };
              };
            }
          )
        );
      };
      # 刻意避开 tailnet-https 的 8000-8199：那段回环端口会被自动暴露，TTS 只走 ssh。
      frontPort = port 8290;
      backendPort = port 8291;
      enginePort = port 8292;
      requiredVram = mkOption {
        type = types.ints.positive;
        default = 9000;
        description = "Free MiB Breeze needs to start; the eager path peaked at 8320.";
      };
      qwen = mkOption {
        default = null;
        description = "Qwen3-TTS Base; null leaves its routes out.";
        type = types.nullOr (
          types.submodule {
            options = {
              directory = mkOption {
                type = types.str;
                description = "Directory whose .venv holds qwen_tts.";
              };
              modelDirectory = mkOption { type = types.str; };
              requiredVram = mkOption {
                type = types.ints.positive;
                default = 6000;
                description = "Free MiB needed to start; cloning peaked at 4487.";
              };
            };
          }
        );
      };
      irodori = mkOption {
        default = null;
        description = "Irodori-TTS; null leaves its routes out.";
        type = types.nullOr (
          types.submodule {
            options = {
              directory = mkOption {
                type = types.str;
                description = "Irodori-TTS checkout whose .venv holds the runtime.";
              };
              checkpoint = mkOption {
                type = types.str;
                default = "Aratako/Irodori-TTS-v4.1-Small";
              };
              requiredVram = mkOption {
                type = types.ints.positive;
                default = 6000;
              };
            };
          }
        );
      };
      ming = mkOption {
        default = null;
        description = "Ming-3.0-tts; null leaves its routes out.";
        type = types.nullOr (
          types.submodule {
            options = {
              directory = mkOption {
                type = types.str;
                description = "Ming checkout whose .venv holds the runtime.";
              };
              modelDirectory = mkOption { type = types.str; };
              requiredVram = mkOption {
                type = types.ints.positive;
                default = 4500;
                description = "Free MiB needed to start; cloning peaked at 2963.";
              };
            };
          }
        );
      };
      mingTiny = mkOption {
        default = null;
        description = "Ming-3.0-tts-tiny with quantized experts; null leaves its routes out.";
        type = types.nullOr (
          types.submodule {
            options = {
              directory = mkOption {
                type = types.str;
                description = "Ming checkout whose .venv and ming_tiny package it shares with Ming.";
              };
              packages = mkOption {
                type = types.str;
                description = "pip --target directory with the tiny-only pins (x-transformers, fla-core).";
              };
              modelDirectory = mkOption { type = types.str; };
              bits = mkOption {
                type = types.enum [
                  4
                  8
                ];
                default = 8;
                description = "Expert weight width; int8 sounds better and still fits 16 GB.";
              };
              requiredVram = mkOption {
                type = types.ints.positive;
                default = 11500;
                description = "Free MiB needed to start; int8 peaked at 11.1 GB while loading.";
              };
            };
          }
        );
      };
      routes = mkOption {
        type = types.attrsOf (types.attrsOf types.str);
        default = {
          anki = {
            en = "breeze";
            zh = "breeze";
            ja = "irodori";
          };
          video = {
            en = "ming";
            zh = "ming-tiny";
            ja = "ming";
          };
        };
        description = "Engine for each use and language.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ package ];

    # Codex 跳过本身是软链接的 SKILL.md，只跟随软链接的目录，所以它拿整个目录。
    home.file = {
      ".claude/skills/local-models/SKILL.md".source = ../skills/local-models/SKILL.md;
      ".agents/skills/local-models/SKILL.md".source = ../skills/local-models/SKILL.md;
      ".codex/skills/local-models".source = ../skills/local-models;
      ".claude/skills/model-weights/SKILL.md".source = ../skills/model-weights/SKILL.md;
      ".agents/skills/model-weights/SKILL.md".source = ../skills/model-weights/SKILL.md;
      ".codex/skills/model-weights".source = ../skills/model-weights;
    };

    # socket 也要 keep-old：重启 socket 会经 Requires 带停正在跑的后端。换端口后手动重启 socket 才生效。
    systemd.user.sockets.comfyui = {
      Unit = {
        Description = "Socket that starts ComfyUI on the first request";
        X-SwitchMethod = "keep-old";
      }
      // comfyCondition;
      Socket.ListenStream = "127.0.0.1:${toString cfg.comfyui.frontPort}";
      Install.WantedBy = [ "sockets.target" ];
    };
    systemd.user.services.comfyui = {
      Unit = {
        Description = "Front for the on-demand ComfyUI backend";
        Requires = [
          "comfyui.socket"
          "comfyui-backend.service"
        ];
        After = [
          "comfyui.socket"
          "comfyui-backend.service"
        ];
        X-SwitchMethod = "keep-old";
      }
      // comfyCondition;
      Service = front cfg.comfyui.backendPort;
    };
    systemd.user.services.comfyui-backend = {
      Unit = {
        Description = "ComfyUI diffusion server";
        StopWhenUnneeded = true;
        X-SwitchMethod = "keep-old";
      }
      // comfyCondition;
      Service = {
        Type = "simple";
        WorkingDirectory = cfg.comfyui.directory;
        Environment = [ "PORT=${toString cfg.comfyui.backendPort}" ];
        ExecStart = lib.getExe' package.service.comfyui "comfyui-backend";
        ExecStartPost = lib.getExe' package.service.wait "model-wait";
        TimeoutStopSec = 30;
        SuccessExitStatus = [ 143 ];
        Restart = "no";
      };
    };

    systemd.user.sockets.tts = {
      Unit = {
        Description = "Socket that starts the speech gate on the first request";
        X-SwitchMethod = "keep-old";
      }
      // ttsCondition;
      Socket.ListenStream = "127.0.0.1:${toString cfg.tts.frontPort}";
      Install.WantedBy = [ "sockets.target" ];
    };
    systemd.user.services.tts = {
      Unit = {
        Description = "Front for the on-demand speech gate";
        Requires = [
          "tts.socket"
          "tts-backend.service"
        ];
        After = [
          "tts.socket"
          "tts-backend.service"
        ];
        X-SwitchMethod = "keep-old";
      }
      // ttsCondition;
      Service = front cfg.tts.backendPort;
    };
    systemd.user.services.tts-backend = {
      Unit = {
        Description = "Speech gate that runs one model at a time";
        StopWhenUnneeded = true;
        X-SwitchMethod = "keep-old";
      }
      // ttsCondition;
      Service = {
        Type = "simple";
        WorkingDirectory = cfg.tts.directory;
        Environment = [
          "PATH=/run/current-system/sw/bin"
          "PORT=${toString cfg.tts.backendPort}"
          "GATE_CONFIG=${gateConfig}"
        ];
        ExecStart = lib.getExe' package.service.gate "model-gate";
        ExecStartPost = lib.getExe' package.service.wait "model-wait";
        TimeoutStartSec = 300;
        TimeoutStopSec = 30;
        SuccessExitStatus = [ 143 ];
        Restart = "no";
      };
    };

    # 不占显存，所以常驻，不走 socket 和空闲回收。
    systemd.user.services.local-models-web = {
      Unit = {
        Description = "Audition pages for the tailnet";
        X-SwitchMethod = "keep-old";
      }
      // webCondition;
      Service = {
        Type = "simple";
        Environment = [
          "PATH=/run/current-system/sw/bin"
          "PORT=${toString cfg.web.port}"
          "WEB_DIR=${cfg.web.directory}"
        ];
        ExecStart = lib.getExe' package.service.web "model-web";
        SuccessExitStatus = [ 143 ];
        Restart = "on-failure";
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
