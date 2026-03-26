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
      <div className="pg-focusCard" style={{ marginTop: 12 }}>
        <div className="pg-focusLine"><strong>DISCLAIMER OF LIABILITY</strong></div>
        <div className="pg-focusLine">
          The home run projections and picks provided through this application are intended solely for informational
          and entertainment purposes. All projections are based on statistical models and historical data and do not
          constitute financial, sports betting, or gambling advice.
        </div>
        <div className="pg-focusLine">By using this application, you acknowledge and agree that:</div>
        <div className="pg-focusLine">- No guarantees are made regarding the accuracy or outcome of any projection.</div>
        <div className="pg-focusLine">
          - The developer, owner, and affiliates of this application shall not be held liable for any financial loss,
          damage, or adverse outcome resulting from reliance on the information provided.
        </div>
        <div className="pg-focusLine">
          - Sports betting and gambling may be illegal in your jurisdiction. It is your sole responsibility to ensure
          compliance with all applicable laws.
        </div>
        <div className="pg-focusLine">
          - You assume full responsibility for any decisions made based on the projections displayed in this app.
        </div>
        <div className="pg-focusLine">Use this application at your own risk.</div>
      </div>
    </div>
  )
}
