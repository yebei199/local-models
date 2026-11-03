# 命令包装：`environment` 是调用方给的默认值，`${X-默认}` 让显式设空的 TTS_HOST 仍表示本机。
{
  lib,
  bun,
  bash,
  coreutils,
  ffmpeg,
  gnugrep,
  iproute2,
  mpv,
  openssh,
  symlinkJoin,
  systemd,
  tailscale,
  writeShellScriptBin,
  environment ? { },
}:
let
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.fileFilter (file: !file.hasExt "md") ../src;
  };
  path = lib.makeBinPath [
    bash
    coreutils
    ffmpeg
    gnugrep
    iproute2
    mpv
    openssh
    systemd
    tailscale
  ];
  exports = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (
      name: value: "export ${name}=\${${name}-${lib.escapeShellArg value}}"
    ) environment
  );
  # 入口后的 -- 不能省：bun 会吞掉脚本参数里的第一个 --。
  command =
    name: entry: args:
    writeShellScriptBin name ''
      export PATH="${path}:$PATH"
      ${exports}
      exec ${lib.getExe bun} ${source}/src/${entry}.ts -- ${args} "$@"
    '';
in
symlinkJoin {
  name = "local-models";
  paths = [
    (command "scene-image" "scene" "image")
    (command "scene-video" "scene" "video")
    (command "scene-narrate" "narrate" "")
    (command "scene-show" "show" "")
    (command "tts" "tts" "")
  ];
  passthru.service = {
    comfyui = command "comfyui-backend" "backend" "start";
    wait = command "model-wait" "backend" "wait";
    vram = command "model-vram" "backend" "vram";
  };
  meta.mainProgram = "tts";
}
