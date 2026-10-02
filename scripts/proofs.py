#!/usr/bin/env python3
"""Isolated OTS worker. Only canonical commitments leave D1; no wallet use.
Confirmed requires a verified Bitcoin mainnet block from an operator-owned full node.
The verifier token belongs ONLY to this process, never to Bots/operators/browsers.
"""
import base64
import hashlib
import io
import json
import os
import sys
import urllib.request
import urllib.error
from bitcoin.rpc import Proxy
from bitcoin.core import b2lx
from opentimestamps.calendar import RemoteCalendar, DEFAULT_CALENDAR_WHITELIST
from opentimestamps.core.timestamp import DetachedTimestampFile
from opentimestamps.core.op import OpSHA256, OpAppend
from opentimestamps.core.serialize import BytesDeserializationContext, BytesSerializationContext
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation

BASE = os.environ.get('PUNKA_API_URL', 'http://localhost:8787').rstrip('/')
TOKEN = os.environ.get('PROOF_VERIFIER_TOKEN')
CALENDARS = ('https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org')

def api(path, body=None, binary=False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        content = response.read(2_000_000)
        return content if binary else json.loads(content)

def walk(stamp):
    yield stamp
    for child in stamp.ops.values():
        yield from walk(child)

def upgrade(stamp):
    # Calendar URIs in remote receipts are untrusted: explicit official whitelist.
    for node in list(walk(stamp)):
        for attestation in list(node.attestations):
            if isinstance(attestation, PendingAttestation) and attestation.uri in DEFAULT_CALENDAR_WHITELIST:
                try:
                    node.merge(RemoteCalendar(attestation.uri).get_timestamp(node.msg, timeout=15))
                except Exception:
                    pass  # Still pending; network failures cannot imply confirmation.

def verify(stamp):
    rpc_url = os.environ.get('BITCOIN_RPC_URL')
    if not rpc_url:
        return None
    proxy = Proxy(service_url=rpc_url, timeout=15)
    if b2lx(proxy.getblockhash(0)) != '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':
        raise ValueError('Bitcoin mainnet required')
    tip = proxy.getblockcount()
    for digest, attestation in stamp.all_attestations():
        if isinstance(attestation, BitcoinBlockHeaderAttestation) and tip - attestation.height >= 5:
            block_hash = proxy.getblockhash(attestation.height)
            header = proxy.getblockheader(block_hash)
            attestation.verify_against_blockheader(digest, header)
            return attestation.height
    return None

def process(proof):
    payload = proof['payload_json'].encode()
    expected = proof['payload_hash']
    if hashlib.sha256(payload).hexdigest() != expected:
        raise ValueError('Payload commitment mismatch')
    keys = set(json.loads(payload))
    if keys != {'certificateId', 'issuerId', 'courseId', 'issuedAt', 'documentHash', 'status'}:
        raise ValueError('Unexpected public payload fields')
    if proof['r2_key']:
        receipt = api('/api/internal/proofs/' + proof['id'] + '/receipt', binary=True)
        detached = DetachedTimestampFile.deserialize(BytesDeserializationContext(receipt))
        if not isinstance(detached.file_hash_op, OpSHA256) or detached.timestamp.msg.hex() != expected:
            raise ValueError('Receipt commitment mismatch')
    else:
        detached = DetachedTimestampFile.from_fd(OpSHA256(), io.BytesIO(payload))
        commitment = detached.timestamp.ops.add(OpAppend(os.urandom(16))).ops.add(OpSHA256())
        successful = 0
        for calendar in CALENDARS:
            try:
                commitment.merge(RemoteCalendar(calendar).submit(commitment.msg, timeout=15))
                successful += 1
            except Exception:
                pass
        if not successful:
            raise ValueError('Calendar submission failed')
    upgrade(detached.timestamp)
    # Persist the pending receipt before full-node verification, so retry can upgrade it.
    ctx = BytesSerializationContext()
    detached.serialize(ctx)
    encoded = base64.b64encode(ctx.getbytes()).decode()
    api('/api/internal/proofs/' + proof['id'], {'status': 'pending', 'receipt': encoded})
    block = verify(detached.timestamp)
    if block:
        api('/api/internal/proofs/' + proof['id'], {'status': 'confirmed', 'receipt': encoded, 'bitcoinBlock': block})
        print(proof['id'], 'confirmed', 'block', block)
    else:
        print(proof['id'], 'pending (Bitcoin verification pending)')

if __name__ == '__main__':
    if not TOKEN:
        sys.exit('Set PROOF_VERIFIER_TOKEN; never share this token with Bots or browsers.')
    failures = 0
    for proof in api('/api/internal/proofs'):
        try:
            process(proof)
        except Exception:
            failures += 1
            # Never print exceptions: RPC credentials or other secrets can occur in them.
            try:
                api('/api/internal/proofs/' + proof['id'], {'status': 'failed'})
            except Exception:
                pass
            print(proof['id'], 'failed; proof and certificate retained')
    sys.exit(1 if failures else 0)
