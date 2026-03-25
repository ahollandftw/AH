import { runAggregation } from './aggregate.js'

runAggregation()
  .then((r) => {
    console.log('Aggregation OK:', r)
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
