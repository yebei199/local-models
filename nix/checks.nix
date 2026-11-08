# 门禁：工具版本跟 flake.lock 走，在沙箱里对已跟踪文件求值。
{ pkgs, src }:
let
  # 依赖和打包共用一份；tsc 要类型，bun test 要 React 和 happy-dom。
  nodeModules = pkgs.callPackage ./node-modules.nix { };
  check =
    name: tools: script:
    pkgs.runCommand "check-${name}" { nativeBuildInputs = tools; } ''
      export HOME=$TMPDIR
      cp -r ${src} $TMPDIR/src && chmod -R u+w $TMPDIR/src && cd $TMPDIR/src
      ${script}
      touch $out
    '';
in
{
  format = check "format" [ pkgs.nixfmt ] "nixfmt --check flake.nix nix/*.nix";
  lint = check "lint" [ pkgs.biome ] "biome ci --error-on-warnings .";
  types = check "types" [ pkgs.typescript ] ''
    ln -s ${nodeModules}/node_modules node_modules
    tsc -p . && tsc -p web
  '';
  test = check "test" [ pkgs.bun pkgs.ffmpeg ] ''
    ln -s ${nodeModules}/node_modules node_modules
    bun run test
  '';
  ui = (pkgs.callPackage ./package.nix { }).ui;
}
