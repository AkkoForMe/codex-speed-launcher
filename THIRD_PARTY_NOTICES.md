# Third-party notices

Codex Speed Launcher is an independent project. OpenAI, Codex, ChatGPT and Node.js names identify the corresponding products and their owners; they do not imply endorsement.

## Runtime launcher references

The runtime-only CDP launch and renderer adaptation approach was studied from:

- [Kiana-ZY/codexfast-windows](https://github.com/Kiana-ZY/codexfast-windows/tree/d7e0dbff9f832a735cd7c168e45cbcaf9d5b452a), local reference version `0.49.1`, MIT.
- [Veath/codexfast](https://github.com/Veath/codexfast), the upstream identified in that project's `UPSTREAM.md`, MIT.

The following notice is preserved for code or substantial portions derived from those sources:

```text
MIT License

Copyright (c) 2026 Veath

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## smol-toml

The configuration reader bundles the parser from [smol-toml](https://github.com/squirrelchat/smol-toml) `1.9.1` under the BSD 3-Clause License.

```text
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Node.js in portable packages

Portable packages bundle an official Node.js `24.22.2` LTS executable for the target OS and architecture. The original Node.js `LICENSE`, including its third-party notices, is included without alteration as `runtime/LICENSE`. Runtime archives are downloaded from [nodejs.org](https://nodejs.org/dist/v24.22.2/) and checked against fixed SHA-256 values and the release's official checksum list. The release date and checksum list are also published in the [official release announcement](https://nodejs.org/en/blog/release/v24.22.2).

Source packages contain no Node.js executable. They require an independently installed Node.js 22 or newer.

Standalone Windows executables embed the same original Node.js license and the launcher notices. Run the executable with `--licenses` to display them without requiring a separate file.

## Executable build tools

The Windows single executable is built with [esbuild](https://github.com/evanw/esbuild) `0.28.2` (MIT, Evan Wallace) and [nodejs/postject](https://github.com/nodejs/postject) `1.0.0-alpha.6` (MIT, Node.js contributors). They are fixed, integrity-checked build inputs; neither is downloaded or run by end users. Their original license texts are included in the executable's `--licenses` output and the generated `THIRD_PARTY_LICENSES.txt`.

## Official Codex application

Codex is installed separately by each user. No official application executable, application archive, authentication file or extracted frontend bundle is included in these distributions. Compatibility testing reads the user's installed application locally; runtime adaptations are applied to the launched process only.
