import { LocationSwitcher } from '../../components/ui/LocationSwitcher'
import { useUi } from '../../state/ui'

export function ConnectionLocation() {
  const location = useUi((state) => state.settingsLocation)
  const setLocation = useUi((state) => state.setSettingsLocation)
  return (
    <section className="settings-section settings-location">
      <div className="settings-location-row">
        <LocationSwitcher value={location} onChange={setLocation} />
      </div>
    </section>
  )
}
