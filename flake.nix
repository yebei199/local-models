{
  description = "Local image, video and speech model commands for a single inference host";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system}.default = pkgs.callPackage ./nix/package.nix { };
      homeManagerModules.default = ./nix/home-module.nix;
      checks.${system} = import ./nix/checks.nix {
        inherit pkgs;
        src = self;
      };
      formatter.${system} = pkgs.nixfmt;
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.biome
          pkgs.bun
          pkgs.ffmpeg
          pkgs.nixfmt
          pkgs.typescript
        ];
      };
    };
}
