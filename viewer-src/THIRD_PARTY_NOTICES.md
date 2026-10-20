# Third-party notices

UV Web Viewer is a browser port of the protocol code of MacViewer. The MIT
notice for that code and the notices for the bundled third-party components are
reproduced here.

## MacViewer (protocol code ported to TypeScript)

MIT License

Copyright (c) 2026 MacViewer contributors

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

## Zstandard

MacViewer statically includes compression and decompression portions of
[Zstandard 1.5.7](https://github.com/facebook/zstd/tree/v1.5.7), copyright Meta
Platforms, Inc. and affiliates, under its BSD license. The source's alternative
GPLv2 license is also preserved. Original notices are in
`ThirdParty/zstd/LICENSE` and `ThirdParty/zstd/COPYING`, and the packaging script
copies both into `MacViewer.app/Contents/Resources/Licenses/Zstandard/`.

In this web viewer the decompression portion of Zstandard is compiled to
WebAssembly. Zstandard is offered under the BSD license (see
https://github.com/facebook/zstd/blob/v1.5.7/LICENSE) or, alternatively, GPLv2
(https://github.com/facebook/zstd/blob/v1.5.7/COPYING).

## 8bit.dat

This viewer includes the supplied `UltraViewer/8bit.dat` Zstandard decoding
dictionary as data at `src/codec/8bit.dat`. It is 112,640 bytes with
SHA-256 `9aa45789d9ff9d329a623a685d57b67e33c777019de9ce1f273f21860e4bfe6b`
and dictionary ID `0x3da0bd10`. This is an UltraViewer-supplied asset, not an
independently authored or open-source dictionary. No redistribution license for
that asset was established; the supplied asset is retained for this local
interoperability build. No Windows executable code is embedded.


## node-forge

The in-browser TLS client uses [node-forge 1.4](https://github.com/digitalbazaar/forge),
used under its New BSD License (3-clause) option (it is alternatively offered under GPLv2):

New BSD License (3-clause)
Copyright (c) 2010, Digital Bazaar, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of Digital Bazaar, Inc. nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL DIGITAL BAZAAR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
