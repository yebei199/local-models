# 命令包装：`environment` 是调用方给的默认值，`${X-默认}` 让显式设空的 TTS_HOST 仍表示本机。
{
  lib,
  bun,
  bash,
  callPackage,
  coreutils,
  ffmpeg,
  gnugrep,
  iproute2,
  mpv,
  openssh,
  stdenvNoCC,
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
  nodeModules = callPackage ./node-modules.nix { };
  # 浏览器端：构建产物由 model-web 托管，运行时不带 node_modules。
  ui = stdenvNoCC.mkDerivation {
    name = "local-models-ui";
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../src/audition.ts
        (lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/dist))
      ];
    };
    nativeBuildInputs = [ bun ];
    buildPhase = ''
      export HOME=$TMPDIR
      ln -s ${nodeModules}/node_modules node_modules
      bun --bun node_modules/vite/bin/vite.js build web --outDir $out --emptyOutDir
    '';
    dontInstall = true;
  };
  engines = lib.fileset.toSource {
    root = ../engines;
    fileset = ../engines;
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
  commandWith =
    extra: name: entry: args:
    writeShellScriptBin name ''
      export PATH="${path}:$PATH"
      # bun 的 fetch 会走代理环境变量，模型主机的回环请求不能经过它。
      export NO_PROXY="127.0.0.1,localhost''${NO_PROXY:+,$NO_PROXY}"
      ${exports}
      ${extra}
      exec ${lib.getExe bun} ${source}/src/${entry}.ts -- ${args} "$@"
    '';
  command = commandWith "";
in
symlinkJoin {
  name = "local-models";
  paths = [
    (command "scene-image" "scene" "image")
    (command "scene-video" "scene" "video")
    (command "scene-music" "scene" "music")
    (command "scene-narrate" "narrate" "")
    (command "scene-show" "show" "")
    (command "tts" "tts" "")
  ];
  passthru.service = {
    comfyui = command "comfyui-backend" "backend" "start";
    wait = command "model-wait" "backend" "wait";
    gate = command "model-gate" "gate" "";
    web = commandWith "export WEB_UI=${ui}" "model-web" "web" "";
  };
  passthru.engines = engines;
  passthru.ui = ui;
  passthru.nodeModules = nodeModules;
  meta = {
    license = lib.licenses.gpl3Only;
    mainProgram = "tts";
  };
}
