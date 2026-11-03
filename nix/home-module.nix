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
      TTS_VOICE = cfg.tts.voice;
      TTS_VOICE_TEXT = cfg.tts.voiceText;
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
  comfyCondition.ConditionPathIsDirectory = "${cfg.comfyui.directory}/ComfyUI";
  ttsCondition.ConditionPathIsDirectory = cfg.tts.directory;
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
      default = "15min";
      description = "Idle time after which a service exits and returns its VRAM.";
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
      voice = mkOption {
        type = types.str;
        description = "Default reference audio.";
      };
      voiceText = mkOption {
        type = types.str;
        description = "Exact transcript of the reference audio.";
      };
      # 刻意避开 tailnet-https 的 8000-8199：那段回环端口会被自动暴露，TTS 只走 ssh。
      frontPort = port 8290;
      backendPort = port 8291;
      requiredVram = mkOption {
        type = types.ints.positive;
        default = 9000;
        description = "Free MiB needed to start; the eager path peaked at 8320.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ package ];

    systemd.user.sockets.comfyui = {
      Unit = {
        Description = "Socket that starts ComfyUI on the first request";
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
        Restart = "no";
      };
    };

    systemd.user.sockets.tts = {
      Unit = {
        Description = "Socket that starts Breeze-TTS-2 on the first request";
      }
      // ttsCondition;
      Socket.ListenStream = "127.0.0.1:${toString cfg.tts.frontPort}";
      Install.WantedBy = [ "sockets.target" ];
    };
    systemd.user.services.tts = {
      Unit = {
        Description = "Front for the on-demand Breeze-TTS-2 backend";
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
        Description = "Breeze-TTS-2 synthesis server";
        StopWhenUnneeded = true;
        X-SwitchMethod = "keep-old";
      }
      // ttsCondition;
      Service = {
        Type = "simple";
        WorkingDirectory = cfg.tts.directory;
        Environment = [
          "PATH=${lib.makeBinPath [ pkgs.sox ]}:/run/current-system/sw/bin"
          "PORT=${toString cfg.tts.backendPort}"
          "LD_LIBRARY_PATH=${cfg.cudaLibraryPath}"
          "HF_HUB_OFFLINE=1"
          "TOKENIZERS_PARALLELISM=false"
        ];
        ExecStartPre = "${lib.getExe' package.service.vram "model-vram"} ${toString cfg.tts.requiredVram} 30";
        ExecStart = "${cfg.tts.directory}/.venv/bin/python -m breeze_infer.api ${cfg.tts.modelDirectory} --host 127.0.0.1 --port ${toString cfg.tts.backendPort}";
        ExecStartPost = lib.getExe' package.service.wait "model-wait";
        TimeoutStartSec = 300;
        TimeoutStopSec = 30;
        SuccessExitStatus = [ 143 ];
        Restart = "no";
      };
    };
  };
}
