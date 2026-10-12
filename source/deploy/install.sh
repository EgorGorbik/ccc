#!/usr/bin/env bash
# First install only, from the extracted release directory on falcon-server-1.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ ${EUID} -eq 0 ]] || { echo 'Run as an operator with root access; gh-runner cannot deploy Docker/nginx.' >&2; exit 1; }
for command in docker nginx certbot openssl getent ss curl realpath; do command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }; done
docker compose version >/dev/null
nginx -t
[[ -n ${LE_EMAIL:-} ]] || { echo 'Set LE_EMAIL to the certificate notification email.' >&2; exit 1; }
getent ahostsv4 falconai.time | awk '{print $1}' | sort -u | awk 'BEGIN{ok=0;bad=0} $0=="139.60.162.14"{ok=1} $0!="139.60.162.14"{bad=1} END{exit(!ok||bad)}' || { echo 'DNS must resolve falconai.time to 139.60.162.14 first.' >&2; exit 1; }
[[ -z $(ss -H -ltn 'sport = :3187') ]] || { echo 'Port3187 is already in use; stopping.' >&2; exit 1; }
if docker container inspect falcon-time >/dev/null 2>&1; then echo 'Container falcon-time exists; use the documented upgrade procedure.' >&2; exit 1; fi
if docker volume inspect falcon_time_data >/dev/null 2>&1; then echo 'Existing Falcon data volume detected; refusing a first install.' >&2; exit 1; fi
if nginx -T 2>&1 | awk '/^[[:space:]]*server_name.*falconai[.]time/{found=1} END{exit !found}'; then echo 'Existing nginx vhost owns falconai.time; inspect before installing.' >&2; exit 1; fi
vhost=/etc/nginx/conf.d/falcon-time.conf
[[ ! -e $vhost ]] || { echo 'Vhost path already exists; stopping.' >&2; exit 1; }
apply_vhost() {
    local previous
    previous=$(mktemp)
    local existed=0
    if [[ -f $vhost ]]; then cp -- "$vhost" "$previous"; existed=1; fi
    install -m644 "$1" "$vhost"
    if ! nginx -t || ! nginx -s reload; then
        if [[ $existed -eq 1 ]]; then install -m644 "$previous" "$vhost"; else rm -- "$vhost"; fi
        rm -- "$previous"
        nginx -t && nginx -s reload
        echo 'Falcon vhost update failed; previous nginx configuration restored.' >&2
        return 1
    fi
    rm -- "$previous"
}
[[ -z ${FALCON_IMPORT_BACKUP:-} || -f $FALCON_IMPORT_BACKUP ]] || { echo 'FALCON_IMPORT_BACKUP is not a file.' >&2; exit 1; }
install -d -m700 secrets
if [[ ! -e secrets/owner_code ]]; then openssl rand -hex 32 > secrets/owner_code; fi
chown 1000:1000 secrets/owner_code
chmod 600 secrets/owner_code
docker compose build
if [[ -n ${FALCON_IMPORT_BACKUP:-} ]]; then
    # Only this container's data volume is modified. No Docker socket is mounted.
    docker compose run --rm --no-deps --user 0:0 --entrypoint sh \
        --volume "$(realpath "$FALCON_IMPORT_BACKUP"):/migration/input.json:ro" app \
        -c 'node server/import-backup.mjs /migration/input.json /data/falcon.sqlite && chown 1000:1000 /data/falcon.sqlite'
fi
docker compose up -d --wait --wait-timeout 90
install -d -m755 /var/www/falcon-time-acme
apply_vhost deploy/falconai.time.http.conf
certbot certonly --non-interactive --agree-tos --email "$LE_EMAIL" --cert-name falconai.time --webroot -w /var/www/falcon-time-acme -d falconai.time
apply_vhost deploy/falconai.time.https.conf
curl --fail --silent --show-error https://falconai.time/healthz
printf '\nFalcon Time is listening at https://falconai.time in container falcon-time.\n'
if [[ -z ${FALCON_IMPORT_BACKUP:-} ]]; then printf 'Owner login: zafar. Code is in secrets/owner_code (not printed to logs).\n'; else printf 'Use the existing owner code from the imported cabinet; reconnect devices.\n'; fi
printf 'Configure and verify the certbot renew timer and an off-server backup destination.\n'
