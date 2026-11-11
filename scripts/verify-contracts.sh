#!/usr/bin/env bash
set -euo pipefail
contract_python=${RHTV_CONTRACT_PYTHON:-.local/contract-tools/bin/python}
if [[ ! -x "$contract_python" ]]; then
  echo 'Set up isolated contract tooling: python3 -m venv .local/contract-tools && .local/contract-tools/bin/python -m pip install -r scripts/contract-requirements.txt' >&2
  exit 1
fi
"$contract_python" contracts/validate_contract.py
"$contract_python" -m unittest discover -s tests/contracts -v
