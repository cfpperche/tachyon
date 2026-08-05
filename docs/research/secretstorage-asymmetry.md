# SecretStorage neste host: **não há assimetria contra same-uid**

**Veredito: não.** Neste host (WSL2 Ubuntu, VS Code Server conectado ao VS Code desktop no
Windows), um processo iniciado do shell como o mesmo usuário consegue recuperar o segredo gravado
por `context.secrets.store` sem passar pelo extension host. O armazenamento efetivo está no cliente
Windows, em um SQLite legível pelo usuário, com o valor cifrado por uma chave que o mesmo processo
consegue abrir via DPAPI do usuário Windows.

Isso refuta a assimetria requerida pela proposta: SecretStorage protege o valor em repouso contra
leitura casual do arquivo, mas não separa dois processos executando sob a mesma identidade do usuário.

## Prova no host

Medição feita em 2026-08-05. O segredo real já criado por Tachyon foi usado como sonda, sem
alterá-lo:

```text
extensionId = cfpperche.tachyon
key         = tachyon.callerIdentity.hmacKey
```

### Onde fica

A linha existe no banco do VS Code desktop:

```text
C:\Users\cfpp\AppData\Roaming\Code\User\globalStorage\state.vscdb
key = secret://{"extensionId":"cfpperche.tachyon","key":"tachyon.callerIdentity.hmacKey"}
value length = 368
```

O arquivo é um SQLite de 5.115.904 bytes. Visto do WSL, ele e o arquivo que contém a chave
mestra do Chromium/VS Code são diretamente legíveis pelo uid 1000:

```text
-rwxrwxrwx (777) goat:goat C:\...\Code\User\globalStorage\state.vscdb
-rwxrwxrwx (777) goat:goat C:\...\Code\Local State
```

`777` é a projeção DrvFS, não a ACL NTFS. A ACL Windows do banco confirma controle total para
o usuário do desktop e também concede modificação ao grupo usado pelo sandbox:

```text
DESKTOP-BGG95NA\CodexSandboxUsers:(I)(M,DC)
NT AUTHORITY\SYSTEM:(I)(F)
BUILTIN\Administrators:(I)(F)
DESKTOP-BGG95NA\cfpp:(I)(F)
```

As permissões não são a barreira pretendida: o agente é `goat`/uid 1000 no WSL e pode iniciar
`cmd.exe`/`powershell.exe` como `DESKTOP-BGG95NA\cfpp`, a mesma identidade Windows que executa o VS
Code.

### Recuperação fora do extension host

O valor do banco é um blob Chromium `v10` (AES-256-GCM). `Code\Local State` contém
`os_crypt.encrypted_key`, protegida com DPAPI `CurrentUser`. A sonda executada do shell fez:

1. leitura somente-leitura da linha SQLite com `node:sqlite`;
2. leitura de `Local State`;
3. chamada a `ProtectedData.Unprotect(..., CurrentUser)` em `powershell.exe`, iniciado pelo agente;
4. decifração AES-256-GCM do blob no processo Node do agente.

Saída integral da sonda, deliberadamente sem o plaintext:

```json
{"outsideExtensionHost":true,"dpapiMasterKeyBytes":32,"cipherPrefix":"v10","decryptedLength":64,"matchesExpectedSecretShape":true,"sha256":"7c99c121d96c091b28a165a6e7f01b92ab5d6b7d804128634f70194f3c175dcb"}
```

O formato esperado vem do código: `loadOrCreateHmacKey` grava 32 bytes como 64 dígitos
hexadecimais. A autenticação GCM ter passado, seguida por comprimento 64 e regex
`^[0-9a-f]{64}$`, prova que a sonda recuperou o valor, não apenas bytes do arquivo. O SHA-256 serve
somente para tornar a medição repetível sem publicar o segredo.

## Caso VS Code Server / WSL

Este workspace roda no servidor remoto, mas o SecretStorage não termina no servidor. O processo
medido foi:

```text
~/.vscode-server/bin/e4c7e7b.../node .../bootstrap-fork --type=extensionHost
```

No bundle desse extension host, `context.secrets` chama `MainThreadSecretState` por RPC:

```text
get   -> this._proxy.$getPassword(extensionId, key)
store -> this._proxy.$setPassword(extensionId, key, value)
```

`lsof` no extension host e no `server-main` não mostrou `state.vscdb`, arquivo de keyring nem socket
D-Bus aberto. Não existe `state.vscdb` sob `~/.vscode-server/data`; a linha real apareceu no
`state.vscdb` do cliente Windows e estava atualizada enquanto esta janela WSL estava ativa. Portanto,
o `gnome-keyring-daemon` presente no Ubuntu não é o backend deste SecretStorage remoto.

O remoto não melhora a fronteira. Pelo contrário, o agente WSL alcança o arquivo do cliente em
`/mnt/c` e pode chamar a DPAPI como o mesmo usuário Windows. Essa é exatamente a rota usada na
sonda acima.

## O que poderia produzir a assimetria neste host

Nada que apenas guarde um segredo sob a mesma conta de usuário produz a propriedade exigida. Nem
permissão `0600`, nem GNOME Keyring desbloqueado, nem Windows Credential Manager/DPAPI separam um
processo arbitrário de outro processo da mesma conta; o chamador pode usar a mesma API ou, neste
caso, invocar a ponte Windows diretamente.

Para obter uma assimetria real seria necessária uma fronteira que o agente não compartilha, por
exemplo:

- um broker sob outra identidade de SO, com o segredo inacessível ao uid/usuário do agente e uma
  credencial de canal que o agente também não possa copiar; ou
- uma operação protegida por presença/consentimento humano a cada gesto (por exemplo, chave com
  verificação de usuário), aceitando que isso prova consentimento naquele momento, não que o
  chamador original era a UI do VS Code.

Com a arquitetura e as identidades atuais deste host, **não há candidato local medido que forneça
“extension host pode, agente same-uid não pode”**.
