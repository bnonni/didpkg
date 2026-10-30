# Install names (grammar draft 1)

Version: draft 1 (2026-10-23). The grammar can change before 1.0. A codec change gives other install names for the same DID, so it breaks the `package.json` entries and the lockfiles that use the old names.

Reference code: [`packages/core/src/name/grammar.ts`](../../packages/core/src/name/grammar.ts) and [`route.ts`](../../packages/core/src/name/route.ts). Commands: `didpkg name <did> <pkg-name>` and `didpkg parse <install-name>` ([CLI reference](../cli.md)).

An install name is the npm package name of a didpkg package. It holds the publisher DID and the package name. npm, pnpm and Bun keep it in `package.json` and in the lockfile. Thus an install name always points to one DID.

## 1. Terms

| Term | Meaning |
|---|---|
| DID | A DID with the syntax of DID Core 1.0 section 3.1: `did:<method>:<method-specific-id>`. |
| msid | The method-specific id of the DID. |
| pkg-name | The package name that the publisher selects, for example `hello`. |
| enc-id | The msid after the fold of section 3. |
| case mask | The data that the fold removes: one bit for each letter, `-` and `.` of the enc-id. |

## 2. Grammar

ABNF (RFC 5234). In this grammar, each quoted string is case-sensitive (RFC 7405).

```abnf
install-name = direct-form / hash-form
direct-form  = scope pkg-name "_" method [ "." case-mask ] "_" enc-id
hash-form    = scope pkg-name "__" did-hash
scope        = "@didpkg/"
pkg-name     = (lower / DIGIT) *63(lower / DIGIT / "." / "-")
method       = 1*(lower / DIGIT)
case-mask    = *b32 b32-nonzero
enc-id       = 1*(lower / DIGIT / "." / "-" / "_")
did-hash     = 51b32 ("a" / "q")
lower        = %x61-7A            ; a-z
b32          = lower / %x32-37    ; RFC 4648 base32 in lowercase: a-z, 2-7
b32-nonzero  = %x62-7A / %x32-37  ; b32 with no "a"
```

These rules also apply:

1. An install name has 214 characters or fewer. npm (`validate-npm-package-name`) does not accept a longer name for a new package.
2. A pkg-name has no `_`, because `_` separates the fields. A pkg-name has 64 characters or fewer, the same limit as the `name` tag of the DWN protocol.
3. The decoded value of a direct-form name must be a DID Core DID.
4. A name must be canonical: the format (section 5) of the parsed DID and pkg-name must give the same name.
5. The hash form is valid only if the direct form of the same DID and pkg-name has more than 214 characters. Thus each pair of a DID and a pkg-name has exactly one install name.

## 3. The fold and the case mask

npm package names have only lowercase letters, digits, `.`, `-` and `_`. A DID can also have uppercase letters and `%`. The fold changes each msid character to one name character. The case mask keeps the data that the fold removes, so the codec has no loss.

| DID character | Name character | Mask bit |
|---|---|---|
| `a`-`z` | the same letter | 0 |
| `A`-`Z` | the lowercase letter | 1 |
| `0`-`9` | the same digit | none |
| `-` | `-` | 0 |
| `_` | `-` | 1 |
| `.` | `.` | 0 |
| `%` | `.` | 1 |
| `:` | `_` | none |

The fold does not decode a percent escape. The 2 hex digits after `%` go through the same table, thus `%3A` becomes `.3a` with the mask bits 1 and 1.

To make the case mask:

1. Write one bit for each letter, `-` and `.` of the enc-id, in order.
2. Put the bits in groups of 5, the first bit as the most significant bit. Fill the last group with 0 bits.
3. Write each group as one character of the RFC 4648 base32 alphabet in lowercase, `abcdefghijklmnopqrstuvwxyz234567`. Thus `a` is the group 0.
4. Remove each `a` at the end.
5. If no character stays, the name has no `.` and no case mask.

Example: the DID `did:web:example.com%3A3000:user:alice` and the pkg-name `hello`.

1. The method is `web`. The msid is `example.com%3A3000:user:alice`.
2. The enc-id is `example.com.3a3000_user_alice`.
3. The bits are 11 times 0 (`example.com`), then 1 (`%`) and 1 (`A`), then 9 times 0 (`user` and `alice`).
4. The groups are `00000 00000 01100 00000 00000`, thus `aamaa`. The case mask is `aam`.
5. The install name is `@didpkg/hello_web.aam_example.com.3a3000_user_alice`.

## 4. The hash form

1. The did-hash is the RFC 4648 base32 in lowercase, with no `=` fill, of the SHA-256 of the UTF-8 bytes of the full DID. It has 52 characters.
2. 256 bits need 52 groups of 5 bits. The last group holds 1 bit and 4 zero bits, thus the last character is `a` or `q`.
3. A hash-form name does not hold the DID. A client must get the DID from another source, for example the lockfile or a local alias. The source is not trusted: the client must make the format of the DID and the pkg-name, and compare it with the name (`bindHash`, code `E_HASH_BIND`).
4. This draft defines no DID binding for a hash-form name. Thus the shim gives HTTP 404 for a hash-form name.

## 5. Format

`format(did, pkg-name)` gives the one install name of the pair:

1. If the pkg-name does not match the grammar, stop with `E_NAME`.
2. If the DID does not match the DID Core syntax, stop with `E_DID`.
3. Fold the msid (section 3). The result is the enc-id and the case mask.
4. Make the direct form. If it has 214 characters or fewer, it is the result.
5. Else, the result is the hash form.

## 6. Parse

`parse(name)` does these steps in order. Each failure has a stable code.

| Step | Check | Code |
|---|---|---|
| 1 | The name has 214 characters or fewer. | `E_LEN` |
| 2 | The name starts with `@didpkg/`. | `E_SCOPE` |
| 3 | The rest has a `_`. | `E_SHAPE` |
| 4 | The text before the first `_` is a pkg-name. | `E_NAME` |
| 5 | If the next character is `_`, the rest is a did-hash. The result is a hash-form name. | `E_HASH` |
| 6 | The method tag ends at the next `_`. | `E_SHAPE` |
| 7 | The method matches the grammar. | `E_METHOD` |
| 8 | The case mask matches the grammar and does not end with `a`. | `E_MASK` |
| 9 | The enc-id has only the characters of the grammar. | `E_ENC_CHAR` |
| 10 | The case mask sets no bit after the last letter, `-` or `.` of the enc-id. | `E_MASK` |
| 11 | The decoded value is a DID Core DID. | `E_DID` |
| 12 | The format of the DID and the pkg-name gives the same name. | `E_CANONICAL` |

A parser must not decode a percent escape and must not guess. The grammar checks only the DID syntax. The DID method checks the rest. For example, `@didpkg/hello_web_a..b` parses as `did:web:a..b`, but `a..b` is not a valid host name.

## 7. Shim routes

The shim gets the method and the raw path of each request. `route(method, path)` maps it:

| Request | Result |
|---|---|
| `GET` or `HEAD` `/@didpkg/<body>` | The packument of the install name `@didpkg/<body>` |
| `GET` or `HEAD` `/@didpkg/<body>/-/<body>-<version>.tgz` | The tarball of `<version>` (a SemVer 2.0.0 version) |
| `PUT` `/@didpkg/<body>` | HTTP 405: the shim does not publish |
| Another HTTP method | HTTP 405 |
| A path character that is not in `A-Za-z0-9@/%._+-` | HTTP 400 |
| A name that `parse` refuses | HTTP 400 with the code |
| A path that does not match | HTTP 404 |

1. The path can have `%2f` or `%2F` in place of the scope `/`. The router decodes only this escape. Each other `%` gives HTTP 404.
2. The query is never part of the name.
3. The shim makes each tarball URL: `<origin>/<install name>/-/<body>-<version>.tgz?rec=<digest>&vm=<method>`. `rec` is the content digest of the release record. `vm` is the verification method of its first proof ([release records](release-records.md)). The URL holds only facts of the signed release. Thus the URL of a version does not change after a key rotation.
4. If a tarball request has `rec`, the digest in the index must be equal to `rec`. Else the shim gives HTTP 403 (`HISTORY_CHANGED`). A request with `rec` comes from a lockfile, thus the shim also serves a `yanked` version for it.

## 8. Test vectors

The test [`packages/core/test/name/spec.test.ts`](../../packages/core/test/name/spec.test.ts) checks each row of the 2 tables in this section. More vectors: [`vectors.json`](../../packages/core/test/name/vectors.json) (28 DIDs with their sources) and [`golden.json`](../../packages/core/test/name/golden.json) (56 install names).

### Format

| DID | pkg-name | Install name |
|---|---|---|
| `did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` | `hello` | `@didpkg/hello_dht_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` |
| `did:web:nonni.org` | `hello` | `@didpkg/hello_web_nonni.org` |
| `did:web:w3c-ccg.github.io:user:alice` | `my-lib.core` | `@didpkg/my-lib.core_web_w3c-ccg.github.io_user_alice` |
| `did:web:example.com%3A3000:user:alice` | `hello` | `@didpkg/hello_web.aam_example.com.3a3000_user_alice` |
| `did:web:example.com:Users:Alice_Smith` | `hello` | `@didpkg/hello_web.aaiim_example.com_users_alice-smith` |
| `did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK` | `hello` | `@didpkg/hello_key.ixcqfxbqq_z6mkhaxgbzdvotdkl5257faiztigic2qtklgpbnnegta2dok` |
| `did:webvh:QmdmPkUdYzbr9txmx8gM2rsHPgr5L6m3gHjJGAf4vUFoGE:domain.example` | `hello` | `@didpkg/hello_webvh.rkaezfzw_qmdmpkudyzbr9txmx8gm2rshpgr5l6m3ghjjgaf4vufoge_domain.example` |
| `did:plc:ewvi7nxzyoun6zhxrhs64oiz` | `hello` | `@didpkg/hello_plc_ewvi7nxzyoun6zhxrhs64oiz` |
| `did:pkh:tz:tz2BFTyPeYRzxd5aiBchbXN3WCZhx7BqbMBq` | `hello` | `@didpkg/hello_pkh.b2yepsm_tz_tz2bftypeyrzxd5aibchbxn3wczhx7bqbmbq` |
| `did:btcr2:k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu` | `hello` | `@didpkg/hello_btcr2_k1q5pxw76fzmq5fttej05clqr2wlg97zrj7897783pngqwa4kvunm538sev7lgu` |
| `did:ion:EiCZws6U61LV3YmvxmOIlt4Ap5RSJdIkb_lJXhuUPqQYBg` | `hello` | `@didpkg/hello_ion.wpbs5fto_eiczws6u61lv3ymvxmoilt4ap5rsjdikb-ljxhuupqqybg` |
| `did:jwk:eyJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieCI6ImFjYklRaXVNczNpOF91c3pFakoydHBUdFJNNEVVM3l6OTFQSDZDZEgyVjAiLCJ5IjoiX0tjeUxqOXZXTXB0bm1LdG00NkdxRHo4d2Y3NEk1TEtncmwyR3pIM25TRSJ9` | `hello` | `@didpkg/hello__goobl6n3s26agxgbm2aolmhsowtroyffgmfnuas56cvxkyz7iasq` |

The last row is the hash form: its direct form has 216 characters.

### Parse

| Name | Result | Reason |
|---|---|---|
| `@didpkg/hello_dht_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` | `OK` | `did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` |
| `@didpkg/hello_web.b_nonni.org` | `OK` | `did:web:nonnI.org`. It is not `did:web:nonni.org`: its DID document must have this exact `id`. |
| `@didpkg/my_lib_dht_abc` | `OK` | The pkg-name `my` and `did:lib:dht:abc`. The shim gives HTTP 404 (`METHOD_NOT_SUPPORTED`). |
| `@other/hello_dht_abc` | `E_SCOPE` | Another scope |
| `@didpkg%2fhello_dht_abc` | `E_SCOPE` | `parse` does not decode `%2f` |
| `@didpkg/hello~dht~i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` | `E_SHAPE` | The old `~` separator |
| `@didpkg/Hello_dht_abc` | `E_NAME` | An uppercase letter in the pkg-name |
| `@didpkg/hello__abc` | `E_HASH` | A did-hash has 52 characters |
| `@didpkg/hello_DHT_abc` | `E_METHOD` | An uppercase letter in the method |
| `@didpkg/hello_dht.a_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y` | `E_MASK` | A zero case mask must not be in the name |
| `@didpkg/hello_web.abqa_localhost.3a8443` | `E_MASK` | A case mask must not end with `a` |
| `@didpkg/hello_web.abq7_localhost.3a8443` | `E_MASK` | Mask bits after the last letter, `-` or `.` |
| `@didpkg/hello_dht_` | `E_ENC_CHAR` | An empty enc-id |
| `@didpkg/hello_web_localhost%3A8443` | `E_ENC_CHAR` | `%` is not an enc-id character |
| `@didpkg/hello_web_nonni.Org` | `E_ENC_CHAR` | An uppercase letter in the enc-id |
| `@didpkg/hello_web_nonni.org_` | `E_DID` | `did:web:nonni.org:` ends with `:` |
