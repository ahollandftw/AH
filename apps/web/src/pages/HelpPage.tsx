export default function HelpPage() {
  return (
    <div className="pg">
      <h1 className="pg-title">Help</h1>
      <p className="pg-sub">
        Found a bug or have a suggestion? Let us know here.
      </p>
      <a className="wl-addBtn" href="mailto:analytichustle.support@gmail.com?subject=AnalyticHustle%20Support">
        Email analytichustle.support@gmail.com
      </a>
      <div className="pg-focusCard" style={{ marginTop: 12 }}>
        <div className="pg-focusLine">
          Please understand this app is being run by one dev. I am trying my best, but there is definitely a chance
          for issues to arise.
        </div>
      </div>
    </div>
  )
}
