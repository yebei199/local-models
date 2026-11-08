# 按 bun.lock 下载的 node_modules，供前端构建和门禁共用。固定输出才能联网；改 bun.lock 后更新 hash。
{
  lib,
  bun,
  cacert,
  runCommand,
}:
let
  lock = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
    ];
  };
in
runCommand "local-models-node-modules"
  {
    nativeBuildInputs = [ bun ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-RmJwBtGJ6NGJoGrakW/0vScSZyETwCRgIkc5vGD30aE=";
    SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";
  }
  ''
    export HOME=$TMPDIR
    cp ${lock}/package.json ${lock}/bun.lock .
    bun install --frozen-lockfile --ignore-scripts --no-cache --no-progress
    # .bin 里是指向包内的相对链接，构建直接调用包内入口，不需要它；去掉也让输出与安装顺序无关。
    rm -rf node_modules/.bin node_modules/.cache
    mkdir $out && mv node_modules $out/
  ''
