{
  description = "odbattr — automated cross-system testing for the GPP (lucuma) ecosystem";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forEachSystem = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          name = "odbattr";

          packages = with pkgs; [
            # The suites themselves: Node runs the unit tests, Playwright and the CLI tools
            # in tools/; k6 runs the GraphQL-level suites.
            nodejs_22
            k6

            # The stack scripts. openssl is pinned here on purpose: gen-certs.sh uses
            # `req -addext` for the subjectAltName, which macOS's system LibreSSL has not
            # reliably supported. gnupg mints the throwaway SSO signing keypair, jq reads the
            # k6 summary and the image digests, curl is the readiness probe.
            openssl
            gnupg
            jq
            curl
            git
          ];

          # Deliberately *not* in this shell:
          #
          # * docker — the daemon is host-managed (Docker Desktop on macOS), and nixpkgs'
          #   docker-client would shadow it without the Compose v2 plugin that every script
          #   here calls as `docker compose`. Install Docker the normal way for your OS.
          #
          # * Playwright's browser — `npx playwright install --with-deps chromium` is the
          #   right path on macOS and on glibc Linux, and it keeps the browser build in step
          #   with the @playwright/test version in package.json. On NixOS, where that
          #   download will not run, add `playwright-driver.browsers` to the packages above
          #   and set, in this shellHook:
          #       export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
          #       export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
          #   then check that nixpkgs' browser revision matches the npm package's expectation
          #   ("Executable doesn't exist" means it does not).
          #
          # * JDK/sbt — only the documented fallback of building the lucuma images yourself
          #   needs them (plus git-lfs and a 6 GB heap). The normal path pulls from Heroku's
          #   registry.

          shellHook = ''
            if [ -z "''${ODBATTR_QUIET:-}" ]; then
              echo "odbattr · node $(node --version) · $(k6 version | head -1)"

              if ! command -v docker >/dev/null 2>&1; then
                echo "  ⚠ docker is not on PATH — stack/scripts/bootstrap.sh needs it"
              elif ! docker info >/dev/null 2>&1; then
                echo "  ⚠ the docker daemon is not running (start Docker Desktop)"
              fi

              if [ ! -d node_modules ]; then
                echo "  → run 'npm ci' first"
              fi

              echo "  npm run check      typecheck + 94 unit tests, nothing else needed"
              echo "  npm run stack:up   boot the ephemeral stack (needs HEROKU_API_KEY)"
            fi
          '';
        };
      });

      formatter = forEachSystem (pkgs: pkgs.nixpkgs-fmt);
    };
}
