# 门禁：工具版本跟 flake.lock 走，在沙箱里对已跟踪文件求值。
{ pkgs, src }:
let
  # tsc 要 @types/bun 才认得 bun 和 node: 内置模块；改 bun.lock 后更新这个 hash。
  types =
    pkgs.runCommand "bun-types"
      {
        nativeBuildInputs = [ pkgs.bun ];
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-agzptiaiuqOgKBrtYXDMSktee2qwUrREUQq+oBzziVg=";
        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
      }
      ''
        export HOME=$TMPDIR
        cp ${src}/package.json ${src}/bun.lock .
        bun install --frozen-lockfile --ignore-scripts --no-cache
        mkdir $out && mv node_modules $out/
      '';
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
    ln -s ${types}/node_modules node_modules
    tsc -p .
  '';
  test = check "test" [ pkgs.bun pkgs.ffmpeg ] "bun test";
}
