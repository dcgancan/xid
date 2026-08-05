import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Generates the self-signed cert `vite.config.ts` picks up.
 *
 * Phone testing needs TLS: `localhost` is the only insecure origin browsers
 * treat as a secure context, and without a secure context iOS refuses the
 * motion-permission call and Android emits no readings at all. The cert has to
 * name this machine's current LAN address, so it is regenerated rather than
 * committed -- addresses change with the network.
 */

const dir = fileURLToPath(new URL("../.certs/", import.meta.url));
mkdirSync(dir, { recursive: true });

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((nic) => nic && nic.family === "IPv4" && !nic.internal)
  .map((nic) => nic.address);

const ips = [...new Set(["127.0.0.1", ...addresses])];
if (addresses.length === 0) {
  console.warn("No external IPv4 interface found — the cert will only cover localhost.");
}

writeFileSync(
  `${dir}openssl.cnf`,
  `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = xid.local

[ext]
subjectAltName = @alt
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
DNS.1 = localhost
DNS.2 = xid.local
${ips.map((ip, i) => `IP.${i + 1} = ${ip}`).join("\n")}
`,
);

execFileSync(
  "openssl",
  [
    "req", "-x509", "-nodes", "-newkey", "rsa:2048",
    "-keyout", `${dir}key.pem`,
    "-out", `${dir}cert.pem`,
    "-days", "825",
    "-config", `${dir}openssl.cnf`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);

console.log(`Certificate covers: ${ips.join(", ")}`);
for (const ip of addresses) console.log(`  https://${ip}:5180/`);
