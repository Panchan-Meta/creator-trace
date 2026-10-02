"""Offline tests for the isolated processor; no network or production tokens."""
import base64
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from opentimestamps.core.timestamp import DetachedTimestampFile
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import BytesDeserializationContext
spec = importlib.util.spec_from_file_location('proofs', Path(__file__).with_name('proofs.py'))
proofs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proofs)
fixture_dir = Path(__file__).resolve().parents[1] / 'api/test/fixtures'
manifest = json.loads((fixture_dir / 'calendar-pending.json').read_text())
receipt = (fixture_dir / 'calendar-pending.ots').read_bytes()

class ProofTests(unittest.TestCase):
    def test_real_receipt_matches_public_commitment(self):
        detached = DetachedTimestampFile.deserialize(BytesDeserializationContext(receipt))
        self.assertEqual(detached.timestamp.msg.hex(), manifest['payloadHash'])
        self.assertIsInstance(detached.file_hash_op, OpSHA256)

    def test_without_rpc_cannot_confirm(self):
        with patch.dict(proofs.os.environ, {}, clear=True):
            self.assertIsNone(proofs.verify(DetachedTimestampFile.deserialize(BytesDeserializationContext(receipt)).timestamp))

    def test_pending_receipt_stays_pending_and_no_pii_is_sent(self):
        posts = []
        def fake_api(path, body=None, binary=False):
            if binary:
                return receipt
            posts.append(body)
        proof = {'id':'fixture', 'payload_json':manifest['payload'], 'payload_hash':manifest['payloadHash'], 'r2_key':'existing.ots'}
        with patch.object(proofs,'api',fake_api), patch.object(proofs,'upgrade'), patch.dict(proofs.os.environ,{},clear=True):
            proofs.process(proof)
        self.assertEqual([post['status'] for post in posts], ['pending'])
        self.assertEqual(set(posts[0]), {'status','receipt'})
        self.assertEqual(set(json.loads(proof['payload_json'])), {'certificateId','issuerId','courseId','issuedAt','documentHash','status'})

    def test_corrupt_payload_is_rejected_before_network(self):
        proof = {'id':'fixture', 'payload_json':manifest['payload']+' ', 'payload_hash':manifest['payloadHash'], 'r2_key':'existing.ots'}
        with patch.object(proofs,'api') as api:
            with self.assertRaises(ValueError):
                proofs.process(proof)
            api.assert_not_called()

if __name__ == '__main__':
    unittest.main()
