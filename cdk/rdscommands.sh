aws rds-data execute-statement \
  --resource-arn 'arn:aws:rds:us-west-2:333258026273:cluster:apprunnervpcdemocftc-apprunnerdemodatabase4fe5b85-t42vssin08kh' \
  --secret-arn 'arn:aws:secretsmanager:us-west-2:333258026273:secret:AppRunnerDemoDatabaseSecret-puR2duwOXFKV-PluURs' \
  --sql 'select * from postgres limit 10;'

"{\"dbClusterIdentifier\":\"apprunnervpcdemocftc-apprunnerdemodatabase4fe5b85-erxq2kpxs2ks\",\"password\":\"jTF.R,EZlq^3hujHr0Jpqcx=itVJgU\",\"engine\":\"postgres\",\"port\":5432,\"host\":\"apprunnervpcdemocftc-apprunnerdemodatabase4fe5b85-erxq2kpxs2ks.cluster-cw6usqtvunr7.us-west-2.rds.amazonaws.com\",\"username\":\"postgres\"}"

aws rds-data execute-statement \
  --resource-arn 'arn:aws:rds:us-west-2:333258026273:cluster:apprunnervpcdemocftc-apprunnerdemodatabase4fe5b85-i8mfj97prl1w' \
  --secret-arn 'arn:aws:secretsmanager:us-west-2:333258026273:secret:AppRunnerDemoDatabaseSecret-56mE4fLA4EQX-F3qiA9' \
  --database apprunnerdemo \
  --sql "CREATE TABLE access (last_update TIMESTAMP, user_agent VARCHAR (250));"


  CREATE TABLE access (last_update TIMESTAMP, user_agent VARCHAR (250));