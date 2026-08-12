import Foundation
import Capacitor
import HealthKit

/// Minimal HealthKit bridge: body-mass read/write only.
/// Registered in AppViewController (no pod; lives in the App target).
@objc(HealthSyncPlugin)
public class HealthSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthSyncPlugin"
    public let jsName = "HealthSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readWeights", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeWeight", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()
    private var bodyMass: HKQuantityType { HKQuantityType.quantityType(forIdentifier: .bodyMass)! }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuth(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Health data not available on this device"); return
        }
        store.requestAuthorization(toShare: [bodyMass], read: [bodyMass]) { ok, err in
            if let err = err { call.reject(err.localizedDescription) }
            else { call.resolve(["granted": ok]) }
        }
    }

    @objc func readWeights(_ call: CAPPluginCall) {
        let sinceDays = call.getInt("sinceDays") ?? 60
        let start = Calendar.current.date(byAdding: .day, value: -sinceDays, to: Date())!
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let query = HKSampleQuery(sampleType: bodyMass, predicate: predicate,
                                  limit: 500, sortDescriptors: [sort]) { _, samples, err in
            if let err = err { call.reject(err.localizedDescription); return }
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone.current
            var out: [[String: Any]] = []
            for s in (samples as? [HKQuantitySample]) ?? [] {
                out.append([
                    "date": fmt.string(from: s.startDate),
                    "kg": s.quantity.doubleValue(for: .gramUnit(with: .kilo))
                ])
            }
            call.resolve(["samples": out])
        }
        store.execute(query)
    }

    @objc func writeWeight(_ call: CAPPluginCall) {
        guard let kg = call.getDouble("kg"), kg > 0 else {
            call.reject("kg required"); return
        }
        let when: Date
        if let dateStr = call.getString("date") {
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone.current
            when = fmt.date(from: dateStr).map { Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: $0) ?? $0 } ?? Date()
        } else {
            when = Date()
        }
        let qty = HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: kg)
        let sample = HKQuantitySample(type: bodyMass, quantity: qty, start: when, end: when)
        store.save(sample) { ok, err in
            if let err = err { call.reject(err.localizedDescription) }
            else { call.resolve(["saved": ok]) }
        }
    }
}
