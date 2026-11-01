# /ai-gateway CLI 命令规范: 

基础命令行工具: **agw**
agw inst delete <inst-name>
agw inst <instance-name> [stop/start]
     --status <all/requests/error/debug>
     --apikey <Gateway-Key>
     --adminkey <Admin-Key>
     [--tls] <port>
agw router <instance-name>
     --retry <num>
     --timeout <num:s>
     --cold <num:s>
     --filter <on/off>
     --models-fetch <num:h> [<0=off>]
     --transcreet <on/off/res-only>   # 仅非流式响应
agw chan <instance-name>
     --sdk <openai/gemini/claude>
     --provider <channel-name> <"url=BaseURL, key=APIKey">
     [--scope <"model-name=real-name">]
     [--value <BaseURL> <JSON-Key> <Currency>]
     [--proxy <password:name@serve>]
     [--path <上游固定路径>]
     [--warn <num:balance>]
agw fetch chan <channel-name>
agw fetch inst <instance-name> -y

     --max <num>
     --warn <num>
     --kill <on/off>
agw card --generate --balance <num>
agw card --delete <card-id>
agw card --charge <card-id> --balance <num>
agw card --register <on/off>
agw card --length <num-16~128>
agw card ban <card-id>
agw refresh ca
agw record <on/off>
     --server <password:name@serve>
     --max-length <num>
agw encrypt <all/<inst-name>> [<password>]
agw decrypr <all/<inst-name>> [<password>]
agw recrypt <all/<inst-name>> [<new-password>]
agw export <all/<inst-name>> [--QRcode <true/false>]
agw inport <file-path> [<password>]
agw cloudflared <start/stop/restart/clear>
agw lang <language>
agw notice
agw stat <all/daily/weekly/monthly>

# loop 窗口: 
**不输入<>值时值不改变**
agw inst <inst-name>
    status <all/requests/error/debug/usage>
       grep <time/line/content/other>
       dist
          --export -p <export-path>
          --export-type -t <image/table/html>
    edit (loop)
       name=<inst-name>
       port=<port/r=random>
       tls=<on/off>
       apikey=<apikey/0=random/none>
       fetch=<num:min/0=off>
       fliter <on/off>
agw chan <inst-name>
    fetch <all/channel-name>
    edit <channel-name> (loop)
       name=<channel-name>
       url=<BaseURL>
       sdk=<0=openai/1=claude/2=google>
       key=<API-Key>
       balance=<URL>
       balance-key=<JSON-Key>
       delay=<num:ms>
       transcreet=<on/off/res-only>
    default <channel-name>
    lock <channel-name> (立刻锁定)
       --time -t <num:s/time> (锁定到何时)
       --wait -w <num:s/time> (何时锁定)
       --cancel
    unlock <channel-name> (立刻解锁)
       --time -t <num:s/time> (解锁到何时)
       --wait -w <num:s/time> (何时解锁)
       --cancel
    delete <channel-name>
    models <channel-name>
       add <real-name>
       delete <real-name/override-name/*>
    scope <channel-name> (loop)
       models=<real-name*>
       name=<override-name>
       override=<true/false>
       models=<real-name/override-name/*>
       <force/warn/none>
    stat <real-name/override-name/*>
    edit
       models=<real-name/override-name/*>
       max=<num:int, *k, *ki, *m, *mi>
       warn=<num:int, *k, *ki, *m, *mi>
    delete <real-name/override-name/*>
agw admin [login]
    login
        [token=<token/random>]
    expire
          --time -t <num:s/time>
          --wait -w <num:s/time>
          --device -d <device-id/all>
    profile
          change (loop)
                 --avatar <URL/path-to-avatar>
                 --name <admin-name>
                 --profile <content>
                 --other <other>
    logout
          --device -d <device-id/all>
agw register
    name=<user-name>
    password=<user-password>
        recomfirm=<user-password>
    email=<user-email>
    other=<other>
agw cloudflared
     log <silence/log/error/warn/debug>
        grep <time/line/content>
     kill
     start
         --time -t
         --wait -w
     stop
         --time -t
         --wait -w
agw config
     export <config>
           --output -p <path>
           --type -t <0=JSON/1=QRcode>
           --encrypt <true/false>
     import <file-path/QRcode/camera>
           --decrypt <password/none>
           --repair <true/false>
agw crypt <all/config>
     en <password>
     de <password/none>
     re <new-password>