#!/usr/bin/env nu

# _dev/supported-protocols-utils/support_protocols.nu
#  nushell utility to assist with returning defillama protocol data

http get https://api.llama.fi/lite/protocols2
| get parentProtocols
| sort-by id
| select id
| update id {|row| $row.id | str replace -r "^parent#" ""}
| to csv
| save supported_protocols.csv
