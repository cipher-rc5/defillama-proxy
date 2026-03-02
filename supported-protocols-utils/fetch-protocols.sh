#!/bin/bash
# bash shell script utility intended to assist with returning defillama protocol data

# _dev/supported-protocols-utils/fetch-protocols.sh

curl -s https://api.llama.fi/lite/protocols2 | \
  jq -r '
    .parentProtocols |
    sort_by(.id) |
    map({id: (.id | sub("^parent#"; ""))}) |
    ["id"] as $headers |
    $headers, (.[] | [.id]) |
    @csv
  ' > supported_protocols.csv
